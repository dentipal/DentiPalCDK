import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
  } from "aws-lambda";
  import {
    DynamoDBClient,
    QueryCommand,
    UpdateItemCommand,
    ScanCommand,
    ScanCommandInput,
    UpdateItemCommandInput,
  } from "@aws-sdk/client-dynamodb";
  import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
  import {
    CognitoIdentityProviderClient,
    SignUpCommand,
    AdminAddUserToGroupCommand,
  } from "@aws-sdk/client-cognito-identity-provider";
  import { VALID_ROLE_VALUES, getRoleByDbValue } from "./professionalRoles";
  
  const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
  const dynamodb = new DynamoDBClient({ region: process.env.REGION });
  const REFERRALS_TABLE = process.env.REFERRALS_TABLE || "DentiPal-Referrals";
  
  interface RegistrationData {
    email: string;
    firstName: string;
    lastName: string;
    userType: string;
    password: string;
    role?: string;
    clinicName?: string;
    phoneNumber?: string;
    referrerUserSub?: string;
  }
  
  export const handler = async (
    event: APIGatewayProxyEvent
  ): Promise<APIGatewayProxyResult> => {
    try {
      if (!event.body) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
          body: JSON.stringify({ error: "Missing request body" }),
        };
      }
  
      const registrationData: RegistrationData = JSON.parse(event.body);
  
      // Validate required fields
      if (
        !registrationData.email ||
        !registrationData.firstName ||
        !registrationData.lastName ||
        !registrationData.userType ||
        !registrationData.password
      ) {
        return {
          statusCode: 400,
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
          body: JSON.stringify({
            error: "Required fields: email, firstName, lastName, userType, password",
          }),
        };
      }
  
      // Validate professional role if userType is professional
      if (registrationData.userType === "professional") {
        if (!registrationData.role) {
          return {
            statusCode: 400,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
            body: JSON.stringify({
              error: "Role is required for professional users",
              validRoles: VALID_ROLE_VALUES,
            }),
          };
        }
        if (!VALID_ROLE_VALUES.includes(registrationData.role)) {
          return {
            statusCode: 400,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
              "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
            body: JSON.stringify({
              error: `Invalid role: ${registrationData.role}`,
              validRoles: VALID_ROLE_VALUES,
            }),
          };
        }
      }
  
      const email = registrationData.email.toLowerCase();
      const givenName = registrationData.firstName;
      const familyName = registrationData.lastName;
  
      const userAttributes = [
        { Name: "email", Value: email },
        { Name: "given_name", Value: givenName },
        { Name: "family_name", Value: familyName },
        {
          Name: "address",
          Value: `userType:${registrationData.userType}|role:${registrationData.role || "none"}|clinic:${
            registrationData.clinicName || "none"
          }`,
        },
      ];
  
      if (registrationData.phoneNumber) {
        userAttributes.push({ Name: "phone_number", Value: registrationData.phoneNumber });
      }
      if (registrationData.referrerUserSub) {
        userAttributes.push({
          Name: "custom:referredByUserSub",
          Value: registrationData.referrerUserSub,
        });
      }
  
      const signUpCommand = new SignUpCommand({
        ClientId: process.env.CLIENT_ID,
        Username: email,
        Password: registrationData.password,
        UserAttributes: userAttributes,
      });
  
      const signUpResult = await cognito.send(signUpCommand);
  
      // --- NEW REFERRAL LOGIC STARTS HERE ---
      const newUserSub = signUpResult.UserSub;
      const referrerUserSubFromParam = registrationData.referrerUserSub;
  
      if (referrerUserSubFromParam && newUserSub) {
        console.log(
          `Attempting to link new user ${newUserSub} (email: ${email}) to referral by ${referrerUserSubFromParam}.`
        );
        try {
          const scanParams: ScanCommandInput = {
            TableName: REFERRALS_TABLE,
            FilterExpression: "friendEmail = :email AND referrerUserSub = :rSub AND #status = :sentStatus",
            ExpressionAttributeValues: marshall({
              ":email": email,
              ":rSub": referrerUserSubFromParam,
              ":sentStatus": "sent",
            }),
            ExpressionAttributeNames: {
              "#status": "status",
            },
          };
          console.log("Scanning referrals table with params:", JSON.stringify(scanParams));
  
          const scanResult = await dynamodb.send(new ScanCommand(scanParams));
  
          if (scanResult.Items && scanResult.Items.length > 0) {
            const referralRecord = unmarshall(scanResult.Items[0]);
            console.log(`Found matching referral record: ${referralRecord.referralId}`);
  
            const updateReferralParams: UpdateItemCommandInput = {
              TableName: REFERRALS_TABLE,
              Key: marshall({ referralId: referralRecord.referralId }),
              UpdateExpression:
                "SET referredUserSub = :newUserSub, #status = :signedUpStatus, signedUpAt = :now, updatedAt = :now",
              ConditionExpression: "#status = :sentStatus",
              ExpressionAttributeNames: {
                "#status": "status",
              },
              ExpressionAttributeValues: marshall({
                ":newUserSub": newUserSub,
                ":signedUpStatus": "signed_up",
                ":sentStatus": "sent",
                ":now": new Date().toISOString(),
              }),
              ReturnValues: "UPDATED_NEW",
            };
  
            await dynamodb.send(new UpdateItemCommand(updateReferralParams));
            console.log(
              `Referral record ${referralRecord.referralId} updated to 'signed_up' for referredUserSub: ${newUserSub}`
            );
          } else {
            console.log(`No pending referral found for email ${email} and referrer ${referrerUserSubFromParam}.`);
          }
        } catch (referralError) {
          console.error("Error updating referral record during signup:", referralError);
          // Continue silently if referral update fails
        }
      }
      // --- NEW REFERRAL LOGIC ENDS HERE ---
  
      // Determine Cognito group
      let cognitoGroup = "Root";
      if (registrationData.userType === "clinic") {
        cognitoGroup = "Root";
      } else if (registrationData.userType === "professional" && registrationData.role) {
        const roleConfig = getRoleByDbValue(registrationData.role);
        if (roleConfig) {
          cognitoGroup = roleConfig.cognitoGroup;
        } else {
          console.warn(`Unknown professional role: ${registrationData.role}, defaulting to Root group`);
        }
      }
  
      // Add user to group
      try {
        await cognito.send(
          new AdminAddUserToGroupCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            GroupName: cognitoGroup,
          })
        );
        console.log(`Successfully added user ${email} to group ${cognitoGroup}`);
      } catch (groupError) {
        console.warn(`Failed to add user to group ${cognitoGroup}:`, groupError);
      }
  
      return {
        statusCode: 200,
        body: JSON.stringify({
          message: "Registration initiated successfully. Please check your email for verification code.",
          userSub: signUpResult.UserSub,
          email: email,
          userType: registrationData.userType,
          role: registrationData.role || null,
          cognitoGroup: cognitoGroup,
          nextStep:
            "Please check your email and use the verification code to complete registration by calling /auth/verify-otp",
          codeDeliveryDetails: signUpResult.CodeDeliveryDetails,
        }),
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      };
    } catch (error: any) {
      console.error("Error initiating user registration:", error);
      if (error.name === "UsernameExistsException") {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error: "User with this email already exists. Please try signing in instead.",
          }),
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        };
      }
      if (error.name === "InvalidPasswordException") {
        return {
          statusCode: 400,
          body: JSON.stringify({
            error:
              "Password does not meet requirements: minimum 8 characters with uppercase, lowercase, number, and symbol.",
          }),
          headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
          },
        };
      }
      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Failed to initiate registration. Please try again.",
          details: error.message,
        }),
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
          "Access-Control-Allow-Headers": "Content-Type, Authorization",
        },
      };
    }
  };
  