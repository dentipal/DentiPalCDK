"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const { DynamoDBClient, QueryCommand, UpdateItemCommand, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { marshall, unmarshall } = require("@aws-sdk/util-dynamodb");
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");
const professionalRoles_1 = require("./professionalRoles");
const cognito = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamodb = new DynamoDBClient({ region: process.env.REGION }); 
const REFERRALS_TABLE = process.env.REFERRALS_TABLE || 'DentiPal-Referrals';
const handler = async (event) => {
    try {
        const registrationData = JSON.parse(event.body);
        // Validate required fields
        if (!registrationData.email || !registrationData.firstName || !registrationData.lastName || !registrationData.userType || !registrationData.password) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Required fields: email, firstName, lastName, userType, password"
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",  // Allow all origins (you can change this to a specific URL if needed)
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }

        // Validate professional role if userType is professional
        if (registrationData.userType === 'professional') {
            if (!registrationData.role) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: "Role is required for professional users",
                        validRoles: professionalRoles_1.VALID_ROLE_VALUES
                    }),
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    }
                };
            }
            if (!professionalRoles_1.VALID_ROLE_VALUES.includes(registrationData.role)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({
                        error: `Invalid role: ${registrationData.role}`,
                        validRoles: professionalRoles_1.VALID_ROLE_VALUES
                    }),
                    headers: {
                        "Access-Control-Allow-Origin": "*",
                        "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                        "Access-Control-Allow-Headers": "Content-Type, Authorization",
                    }
                };
            }
        }

        // Your existing logic for creating a user...

        const email = registrationData.email.toLowerCase();
        const givenName = registrationData.firstName;
        const familyName = registrationData.lastName;

        const userAttributes = [
            { Name: 'email', Value: email },
            { Name: 'given_name', Value: givenName },
            { Name: 'family_name', Value: familyName },
            { Name: 'address', Value: `userType:${registrationData.userType}|role:${registrationData.role || 'none'}|clinic:${registrationData.clinicName || 'none'}` },
        ];

        // Add optional attributes
        if (registrationData.phoneNumber) {
            userAttributes.push({ Name: 'phone_number', Value: registrationData.phoneNumber });
        }
        if (registrationData.referrerUserSub) {
            userAttributes.push({
                Name: 'custom:referredByUserSub',
                Value: registrationData.referrerUserSub
            });
        }

        const signUpCommand = new client_cognito_identity_provider_1.SignUpCommand({
            ClientId: process.env.CLIENT_ID,
            Username: email,
            Password: registrationData.password,
            UserAttributes: userAttributes,
        });
        const signUpResult = await cognito.send(signUpCommand);
        // --- NEW REFERRAL LOGIC STARTS HERE ---
        // We now have the new user's userSub from signUpResult.UserSub
        const newUserSub = signUpResult.UserSub;
        const referrerUserSubFromParam = registrationData.referrerUserSub; // The sub of the professional who referred

        if (referrerUserSubFromParam && newUserSub) {
            console.log(`Attempting to link new user ${newUserSub} (email: ${email}) to referral by ${referrerUserSubFromParam}.`);
            try {
                // Find the referral record using friendEmail, referrerUserSub, and status 'sent'
                // This requires scanning if no specific GSI for (referrerUserSub, friendEmail) exists.
                // A `Scan` is less efficient than a `Query` with a GSI, but works without extra index.
                // If you have many referrals, consider a GSI on `referrerUserSub` with `friendEmail` as sort key.
                const scanParams = {
                    TableName: REFERRALS_TABLE,
                    FilterExpression: "friendEmail = :email AND referrerUserSub = :rSub AND #status = :sentStatus",
                    ExpressionAttributeValues: marshall({
                        ":email": email,
                        ":rSub": referrerUserSubFromParam,
                        ":sentStatus": "sent",
                    }),
                    ExpressionAttributeNames: {
                        "#status": "status" // 'status' is a reserved word
                    },
                };
                console.log("Scanning referrals table with params:", JSON.stringify(scanParams));
                const scanResult = await dynamodb.send(new ScanCommand(scanParams));
                
                if (scanResult.Items && scanResult.Items.length > 0) {
                    // Pick the first one. In a real system, you might refine this if multiple "sent" invites
                    // exist for the same email from the same referrer (unlikely for professional referrals).
                    const referralRecord = unmarshall(scanResult.Items[0]);
                    console.log(`Found matching referral record: ${referralRecord.referralId}`);

                    const updateReferralParams = {
                        TableName: REFERRALS_TABLE,
                        Key: marshall({ referralId: referralRecord.referralId }),
                        UpdateExpression: "SET referredUserSub = :newUserSub, #status = :signedUpStatus, signedUpAt = :now, updatedAt = :now",
                        ConditionExpression: "#status = :sentStatus", // Only update if status is 'sent'
                        ExpressionAttributeNames: {
                            "#status": "status"
                        },
                        ExpressionAttributeValues: marshall({
                            ":newUserSub": newUserSub,
                            ":signedUpStatus": "signed_up",
                            ":sentStatus": "sent",
                            ":now": new Date().toISOString(),
                        }),
                        ReturnValues: "UPDATED_NEW"
                    };
                    await dynamodb.send(new UpdateItemCommand(updateReferralParams));
                    console.log(`Referral record ${referralRecord.referralId} updated to 'signed_up' for referredUserSub: ${newUserSub}`);
                } else {
                    console.log(`No pending referral found for email ${email} and referrer ${referrerUserSubFromParam}.`);
                }
            } catch (referralError) {
                console.error("Error updating referral record during signup:", referralError);
                // Don't prevent user signup if referral update fails, just log the error.
                // You might want to use a dead-letter queue or another mechanism to reprocess failed referral updates.
            }
        }
        // --- NEW REFERRAL LOGIC ENDS HERE ---

        // Add user to appropriate Cognito group
        let cognitoGroup = 'Root'; // default group
        if (registrationData.userType === 'clinic') {
            cognitoGroup = 'Root';
        } else if (registrationData.userType === 'professional' && registrationData.role) {
            const roleConfig = (0, professionalRoles_1.getRoleByDbValue)(registrationData.role);
            if (roleConfig) {
                cognitoGroup = roleConfig.cognitoGroup;
            } else {
                console.warn(`Unknown professional role: ${registrationData.role}, defaulting to Root group`);
            }
        }

        // Add user to group
        try {
            await cognito.send(new client_cognito_identity_provider_1.AdminAddUserToGroupCommand({
                UserPoolId: process.env.USER_POOL_ID,
                Username: email,
                GroupName: cognitoGroup,
            }));
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
                nextStep: "Please check your email and use the verification code to complete registration by calling /auth/verify-otp",
                codeDeliveryDetails: signUpResult.CodeDeliveryDetails
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
        };
    } catch (error) {
        console.error("Error initiating user registration:", error);
        if (error.name === 'UsernameExistsException') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "User with this email already exists. Please try signing in instead."
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }
        if (error.name === 'InvalidPasswordException') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Password does not meet requirements: minimum 8 characters with uppercase, lowercase, number, and symbol."
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to initiate registration. Please try again.",
                details: error.message
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS, PUT, DELETE",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
        };
    }
};

exports.handler = handler;
