import {
    CognitoIdentityProviderClient,
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminCreateUserCommandInput,
    AdminAddUserToGroupCommandInput,
    AdminSetUserPasswordCommandInput,
    AttributeType, 
} from "@aws-sdk/client-cognito-identity-provider";
import { 
    DynamoDBClient, 
    UpdateItemCommand, 
    UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { 
    SESClient, 
    SendEmailCommand, 
    SendEmailCommandInput 
} from "@aws-sdk/client-ses";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// --- Initialization (using V3 clients) ---
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamodbClient = new DynamoDBClient({ region: REGION }); 
const sesClient = new SESClient({ region: REGION }); 

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the expected structure for the request body
interface RequestBody {
    firstName: string;
    lastName: string;
    phoneNumber: string;
    email: string;
    password?: string;
    verifyPassword?: string;
    subgroup: string;
    clinicIds: string[];
    sendWelcomeEmail?: boolean;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // Handle preflight CORS request
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        console.log("Received event path:", event.path);

        // 1️⃣ Verify Root User Authorization (Access Token)
        let userGroups: string[] = [];
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            console.error("Authentication error:", authError.message);
            return json(401, { 
                error: "Unauthorized", 
                message: authError.message || "Invalid access token" 
            });
        }
        
        // strict check for Root group
        if (!userGroups.includes("Root")) {
            console.warn("Unauthorized user tried to add new user. Groups:", userGroups);
            return json(403, {
                error: "Forbidden",
                message: "Only Root users can add new users",
                details: { requiredGroup: "Root", userGroups }
            });
        }

        // 2️⃣ Parse the body and validate
        const body: RequestBody = JSON.parse(event.body || "{}");
        const { firstName, lastName, phoneNumber, email: rawEmail, password, verifyPassword, subgroup, clinicIds, sendWelcomeEmail } = body;
        const email = rawEmail ? rawEmail.toLowerCase() : "";

        // Log fields for debugging (exclude password)
        console.log("Parsed body:", { ...body, password: "***", verifyPassword: "***" });

        // Validate password match
        if (password !== verifyPassword) {
            return json(400, {
                error: "Bad Request",
                message: "Passwords do not match",
                field: "password"
            });
        }

        // Validate required fields
        if (!firstName || !lastName || !phoneNumber || !email || !password || !subgroup || !clinicIds || clinicIds.length === 0) {
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields",
                requiredFields: ["firstName", "lastName", "phoneNumber", "email", "password", "verifyPassword", "subgroup", "clinicIds"]
            });
        }

        // Validate the subgroup
        const validGroups = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
        if (!validGroups.includes(subgroup)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid subgroup",
                validOptions: validGroups,
                provided: subgroup
            });
        }

        // 3️⃣ Create Cognito user (Admin Flow)
        const adminCreateUserInput: AdminCreateUserCommandInput = {
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            TemporaryPassword: password,
            MessageAction: "SUPPRESS",
            UserAttributes: [
                { Name: "given_name", Value: firstName },
                { Name: "family_name", Value: lastName },
                { Name: "phone_number", Value: phoneNumber },
                { Name: "email", Value: email },
                { Name: "email_verified", Value: "true" }
            ],
        };

        const createUserResponse = await cognitoClient.send(new AdminCreateUserCommand(adminCreateUserInput));
        
        // Get the new user's 'sub' (unique ID) from the response
        const userSub = createUserResponse.User?.Attributes?.find(
            (attr: AttributeType) => attr.Name === "sub"
        )?.Value;

        if (!userSub) {
            throw new Error("Could not find UserSub (sub) in Cognito response.");
        }
        console.log(`New user created with UserSub: ${userSub}`);
        
        // 3.1️⃣ Set the password as permanent
        const setPasswordInput: AdminSetUserPasswordCommandInput = {
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true,
        };

        await cognitoClient.send(new AdminSetUserPasswordCommand(setPasswordInput));
        
        // 3.2️⃣ Add user to group
        const addToGroupInput: AdminAddUserToGroupCommandInput = {
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            GroupName: subgroup,
        };
        await cognitoClient.send(new AdminAddUserToGroupCommand(addToGroupInput));
        console.log(`User ${email} added to group ${subgroup}`);

        // 4️⃣ Store userSub in the clinics' associated users
        const CLINICS_TABLE_NAME = process.env.CLINICS_TABLE || "DentiPal-Clinics"; 

        const updatePromises = clinicIds.map(clinicId => {
            const clinicUpdateParams: UpdateItemCommandInput = {
                TableName: CLINICS_TABLE_NAME,
                Key: { clinicId: { S: clinicId } }, 
                UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty_list), :userSub)",
                ExpressionAttributeValues: {
                    ":userSub": { L: [{ S: userSub }] }, 
                    ":empty_list": { L: [] },
                },
                ReturnValues: "UPDATED_NEW",
            };
            return dynamodbClient.send(new UpdateItemCommand(clinicUpdateParams));
        });

        await Promise.all(updatePromises);
        console.log(`Updated ${clinicIds.length} clinics with new userSub.`);

        // 5️⃣ Send welcome email (optional)
        if (sendWelcomeEmail) {
            console.log(`Attempting to send welcome email to ${email}...`);

            const subject = "Your DentiPal Account Details";
            const clinicsLine = Array.isArray(clinicIds) && clinicIds.length ? clinicIds.join(", ") : "";

            const htmlBody = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background-color:#fff0f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff0f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);padding:32px 40px;text-align:center;">
          <h1 style="margin:0;font-size:28px;color:#532b21;letter-spacing:0.5px;">DentiPal</h1>
          <p style="margin:8px 0 0;color:#7a4a3a;font-size:14px;">Account Created</p>
        </td></tr>

        <!-- Greeting -->
        <tr><td style="padding:32px 40px 16px;">
          <h2 style="margin:0;font-size:22px;color:#333;">Hello, ${firstName}!</h2>
          <p style="margin:8px 0 0;font-size:15px;color:#666;">Your DentiPal account has been created by your administrator. Here are your login details:</p>
        </td></tr>

        <!-- Credentials Card -->
        <tr><td style="padding:0 40px 24px;">
          <table width="100%" style="background:#fef7f5;border-radius:12px;" cellpadding="0" cellspacing="0">
            <tr><td style="padding:20px 24px;">
              <table width="100%" cellpadding="0" cellspacing="0" style="font-size:15px;">
                <tr>
                  <td style="padding:8px 0;color:#999;width:100px;">Email</td>
                  <td style="padding:8px 0;font-weight:600;color:#333;">${email}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#999;border-top:1px solid #fde8e4;">Password</td>
                  <td style="padding:8px 0;font-weight:600;color:#333;border-top:1px solid #fde8e4;font-family:monospace;background:#fff5f3;padding-left:8px;border-radius:4px;">${password}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#999;border-top:1px solid #fde8e4;">Role</td>
                  <td style="padding:8px 0;font-weight:600;color:#333;border-top:1px solid #fde8e4;">${subgroup}</td>
                </tr>
                ${clinicsLine ? `<tr>
                  <td style="padding:8px 0;color:#999;border-top:1px solid #fde8e4;">Clinics</td>
                  <td style="padding:8px 0;font-weight:600;color:#333;border-top:1px solid #fde8e4;">${clinicsLine}</td>
                </tr>` : ""}
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Security Warning -->
        <tr><td style="padding:0 40px 24px;">
          <div style="background:#fff5f3;border-left:4px solid #f8ccc1;padding:14px 18px;border-radius:0 8px 8px 0;">
            <p style="margin:0;font-size:14px;color:#532b21;font-weight:600;">For security, please sign in and change your password immediately.</p>
          </div>
        </td></tr>

        <!-- CTA Button -->
        <tr><td style="padding:0 40px 32px;text-align:center;">
          <a href="https://app.dentipal.com/login" style="display:inline-block;background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);color:#532b21;padding:14px 36px;border-radius:10px;font-weight:700;font-size:15px;text-decoration:none;">
            Sign In Now
          </a>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#fef7f5;padding:20px 40px;border-top:1px solid #fde8e4;text-align:center;">
          <p style="margin:0 0 4px;font-size:13px;color:#999;">If you did not expect this email, please contact your administrator.</p>
          <p style="margin:0;font-size:12px;color:#ccc;">DentiPal. All rights reserved.</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

            const textBody =
                `Hello ${firstName},\n\n` +
                `Your DentiPal account has been created.\n\n` +
                `Email: ${email}\n` +
                `Password: ${password}\n` +
                `Role: ${subgroup}\n` +
                (clinicsLine ? `Clinics: ${clinicsLine}\n` : "") +
                `\nFor security, please sign in and change your password immediately.\n` +
                `Sign in: https://app.dentipal.com/login\n\n` +
                `If you did not expect this email, please contact your administrator.\n`;

            const emailParams: SendEmailCommandInput = {
                Source: process.env.SES_FROM_EMAIL || "swarajparamata@gmail.com",
                Destination: { ToAddresses: [email] },
                Message: {
                    Subject: { Data: subject },
                    Body: {
                        Text: { Data: textBody },
                        Html: { Data: htmlBody }
                    }
                }
            };

            try {
                await sesClient.send(new SendEmailCommand(emailParams));
                console.log(`Welcome email sent to ${email}`);
            } catch (emailError) {
                console.error("Failed to send welcome email:", emailError);
                // Don't fail the request if email fails
            }
        }

        return json(201, {
            status: "success",
            message: "User created successfully",
            data: {
                userSub,
                email,
                firstName,
                lastName,
                subgroup,
                clinics: clinicIds,
                createdAt: new Date().toISOString(),
            },
        });

    } catch (error) {
        const err = error as Error & { name?: string; message?: string };
        console.error("Error creating user:", err);
        
        // Handle specific Cognito errors
        let statusCode = 500;
        let errorMessage = "Internal Server Error";
        let details: any = { message: err.message };

        if (err.name === "UsernameExistsException") {
            statusCode = 409;
            errorMessage = "Conflict";
            details = { message: "User with this email already exists" };
        } else if (err.name === "InvalidPasswordException") {
            statusCode = 400;
            errorMessage = "Bad Request";
            details = { message: "Password does not meet requirements" };
        } else if (err.name === "InvalidParameterException") {
            statusCode = 400;
            errorMessage = "Bad Request";
        } else if (err.name === "LimitExceededException") {
            statusCode = 429;
            errorMessage = "Too Many Requests";
        }

        return json(statusCode, {
            error: errorMessage,
            details,
            timestamp: new Date().toISOString(),
        });
    }
};