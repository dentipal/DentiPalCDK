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
import { extractUserFromBearerToken, isRoot } from "./utils";
import { corsHeaders } from "./corsHeaders";

// --- Initialization (using V3 clients) ---
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamodbClient = new DynamoDBClient({ region: REGION }); 
const sesClient = new SESClient({ region: REGION }); 

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
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
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // Handle preflight CORS request
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
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
            return json(event, 401, { 
                error: "Unauthorized", 
                message: authError.message || "Invalid access token" 
            });
        }
        
        // strict check for Root group (case-insensitive via isRoot helper)
        if (!isRoot(userGroups)) {
            console.warn("Unauthorized user tried to add new user. Groups:", userGroups);
            return json(event, 403, {
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
            return json(event, 400, {
                error: "Bad Request",
                message: "Passwords do not match",
                field: "password"
            });
        }

        // Validate required fields
        if (!firstName || !lastName || !phoneNumber || !email || !password || !subgroup || !clinicIds || clinicIds.length === 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Missing required fields",
                requiredFields: ["firstName", "lastName", "phoneNumber", "email", "password", "verifyPassword", "subgroup", "clinicIds"]
            });
        }

        // Validate the subgroup
        const validGroups = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
        if (!validGroups.includes(subgroup)) {
            return json(event, 400, {
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

            const subject = "Welcome to DentiPal — your account is ready";
            const clinicsLine = Array.isArray(clinicIds) && clinicIds.length ? clinicIds.join(", ") : "";
            const escapeForHtml = (s: string) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c] as string));
            const safeFirstName = escapeForHtml(firstName);
            const safeEmail = escapeForHtml(email);
            const safePassword = escapeForHtml(password);
            const safeSubgroup = escapeForHtml(subgroup);
            const safeClinics = escapeForHtml(clinicsLine);
            const fontStack = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
            const year = new Date().getFullYear();

            const credentialRow = (label: string, value: string, mono: boolean = false, isLast: boolean = false) => {
                const border = isLast ? "" : "border-bottom:1px solid #e8e8ed;";
                const valueStyle = mono
                    ? `font-family:'SF Mono','Menlo','Consolas',monospace;font-size:14px;background:rgba(245,245,247,0.8);padding:6px 10px;border-radius:6px;display:inline-block;letter-spacing:0;`
                    : `font-size:14px;letter-spacing:-0.01em;`;
                return `<tr>
                    <td style="padding:14px 0;color:#6e6e73;font-size:14px;font-weight:400;letter-spacing:-0.01em;${border}">${label}</td>
                    <td style="padding:14px 0;color:#1d1d1f;font-weight:500;text-align:right;${border}"><span style="${valueStyle}">${value}</span></td>
                </tr>`;
            };

            const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>Your DentiPal account is ready</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:${fontStack};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">Your DentiPal account has been created. Sign in and change your password to get started.</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
    <tr><td align="center" style="padding:48px 16px;">
      <table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;width:100%;">

        <tr><td style="padding:0 8px 18px;text-align:center;">
          <span style="display:inline-block;font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.02em;">DentiPal</span>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 40px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:44px 40px 32px;">

              <p style="margin:0 0 10px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Account created</p>
              <h1 style="margin:0 0 14px;color:#1d1d1f;font-size:28px;font-weight:700;letter-spacing:-0.025em;line-height:1.15;">Welcome, ${safeFirstName}</h1>
              <p style="margin:0 0 28px;color:#424245;font-size:16px;line-height:1.55;letter-spacing:-0.01em;">
                Your administrator has set up a DentiPal account for you. Use the credentials below to sign in. For your security, you'll be asked to change your password right after your first sign-in.
              </p>

              <p style="margin:0 0 12px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Your sign-in details</p>
              <table cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;margin:0 0 28px;">
                <tr><td style="padding:6px 22px;">
                  <table width="100%" cellpadding="0" cellspacing="0">
                    ${credentialRow("Email", safeEmail)}
                    ${credentialRow("Temporary password", safePassword, true)}
                    ${credentialRow("Role", safeSubgroup, false, !safeClinics)}
                    ${safeClinics ? credentialRow("Clinics", safeClinics, false, true) : ""}
                  </table>
                </td></tr>
              </table>

              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr><td align="center">
                  <a href="https://dentipal.com/login" style="display:inline-block;background:#1d1d1f;color:#ffffff;padding:14px 32px;border-radius:980px;font-size:15px;font-weight:500;text-decoration:none;letter-spacing:-0.01em;line-height:1;">Sign in to DentiPal</a>
                </td></tr>
              </table>

              <div style="margin:32px 0 0;padding:18px 20px;background:rgba(245,245,247,0.7);border:1px solid rgba(0,0,0,0.04);border-radius:14px;">
                <p style="margin:0 0 6px;color:#1d1d1f;font-size:13px;font-weight:600;letter-spacing:-0.005em;">Keep your account secure</p>
                <p style="margin:0;color:#6e6e73;font-size:13px;line-height:1.55;letter-spacing:-0.005em;">
                  Change your temporary password immediately after signing in. Never share your password — DentiPal staff will never ask for it.
                </p>
              </div>

            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px;text-align:center;">
          <p style="margin:0 0 10px;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            If you weren't expecting this email, please contact your administrator or
            <a href="mailto:support@dentipal.com" style="color:#1d1d1f;text-decoration:none;font-weight:500;">support@dentipal.com</a>.
          </p>
          <p style="margin:18px 0 0;color:#a1a1a6;font-size:11px;letter-spacing:0.01em;">&copy; ${year} DentiPal</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

            const textBody =
                `DentiPal\n\n` +
                `Welcome, ${firstName}\n\n` +
                `Your administrator has set up a DentiPal account for you. Use the credentials below to sign in. For your security, you'll be asked to change your password right after your first sign-in.\n\n` +
                `Your sign-in details:\n` +
                `  Email:              ${email}\n` +
                `  Temporary password: ${password}\n` +
                `  Role:               ${subgroup}\n` +
                (clinicsLine ? `  Clinics:            ${clinicsLine}\n` : "") +
                `\nSign in: https://dentipal.com/login\n\n` +
                `Keep your account secure: change your temporary password immediately after signing in. DentiPal staff will never ask for your password.\n\n` +
                `If you weren't expecting this email, please contact your administrator or support@dentipal.com.\n`;

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

        return json(event, 201, {
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

        return json(event, statusCode, {
            error: errorMessage,
            details,
            timestamp: new Date().toISOString(),
        });
    }
};