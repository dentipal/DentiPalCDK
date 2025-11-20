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

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization (using V3 clients) ---
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamodbClient = new DynamoDBClient({ region: REGION }); 
const sesClient = new SESClient({ region: REGION }); 



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
    try {
        console.log("Received event:", JSON.stringify(event));

        // Handle preflight CORS request
        if (event.httpMethod === "OPTIONS") {
            // ✅ Uses imported headers
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({}),
            };
        }

        // 1️⃣ Verify Root User Authorization
        const claims = event.requestContext?.authorizer?.claims || {};
        const rawGroups = claims['cognito:groups'];
        
        // FIX: Cast as 'string | string[]' and allow the variable to hold either type.
        // The groupsArray logic below normalizes it into a string[] anyway.
        const userGroups = (rawGroups || []) as string | string[];
        
        const groupsArray = Array.isArray(userGroups) 
            ? userGroups 
            : String(userGroups).split(',').map(s => s.trim());
        
        if (!groupsArray.includes("Root")) {
            console.warn("Unauthorized user tried to add new user:", groupsArray);
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    message: "Only Root users can add new users",
                    statusCode: 403,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // 2️⃣ Parse the body and validate
        const body: RequestBody = JSON.parse(event.body || "{}");
        const { firstName, lastName, phoneNumber, email, password, verifyPassword, subgroup, clinicIds, sendWelcomeEmail } = body;

        // Log fields for debugging
        console.log("Parsed body:", body);

        // Validate password match
        if (password !== verifyPassword) {
            console.error("Passwords do not match");
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: "Passwords do not match",
                    field: "password",
                    statusCode: 400,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // Validate required fields
        if (!firstName || !lastName || !phoneNumber || !email || !password || !subgroup || !clinicIds || clinicIds.length === 0) {
            console.error("Missing required fields:", { firstName, lastName, phoneNumber, email, password, subgroup, clinicIds });
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: "Missing required fields",
                    requiredFields: ["firstName", "lastName", "phoneNumber", "email", "password", "verifyPassword", "subgroup", "clinicIds"],
                    statusCode: 400,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // Validate the subgroup
        const validGroups = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
        if (!validGroups.includes(subgroup)) {
            console.error("Invalid subgroup:", subgroup);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: "Invalid subgroup",
                    validOptions: validGroups,
                    provided: subgroup,
                    statusCode: 400,
                    timestamp: new Date().toISOString(),
                }),
            };
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
        console.log("Cognito admin create user response:", createUserResponse);

        // Get the new user's 'sub' (unique ID) from the response
        const userSub = createUserResponse.User?.Attributes?.find(
            (attr: AttributeType) => attr.Name === "sub"
        )?.Value;

        if (!userSub) {
            console.error("Could not find UserSub in Cognito response:", createUserResponse);
            throw new Error("Could not find UserSub (sub) in Cognito response.");
        }
        console.log(`New user created with UserSub: ${userSub}`);
        
        // 3.1️⃣ Set the password as permanent
        console.log(`Setting permanent password for ${email}...`);
        const setPasswordInput: AdminSetUserPasswordCommandInput = {
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            Password: password,
            Permanent: true,
        };

        await cognitoClient.send(new AdminSetUserPasswordCommand(setPasswordInput));
        console.log(`Permanent password set for ${email}.`);
        
        // 3.2️⃣ Add user to group
        const addToGroupInput: AdminAddUserToGroupCommandInput = {
            UserPoolId: process.env.USER_POOL_ID,
            Username: email,
            GroupName: subgroup,
        };
        await cognitoClient.send(new AdminAddUserToGroupCommand(addToGroupInput));
        console.log(`User ${email} added to group ${subgroup}`);

        // 4️⃣ Store userSub in the clinics' associated users (using DynamoDBClient v3)
        const CLINICS_TABLE_NAME = "DentiPal-Clinics"; 

        for (const clinicId of clinicIds) {
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

            await dynamodbClient.send(new UpdateItemCommand(clinicUpdateParams));
            console.log(`Clinic ${clinicId} updated with new userSub: ${userSub}`);
        }

        // 5️⃣ Send welcome email (optional)
        if (sendWelcomeEmail) {
            console.log(`Attempting to send welcome email to ${email}...`);

            // Build both text and HTML bodies
            const subject = "Your DentiPal account details";
            const textBody =
                `Hello ${firstName},\n\n` +
                `Your DentiPal account has been created.\n\n` +
                `Email: ${email}\n` +
                `Password: ${password}\n` + // The password
                `Role: ${subgroup}\n` +
                (Array.isArray(clinicIds) && clinicIds.length ? `Clinics: ${clinicIds.join(", ")}\n` : "") +
                `\nFor security, please sign in and change your password immediately.\n` +
                `If you did not expect this email, please contact your administrator.\n`;

            const htmlBody =
                `<p>Hello ${firstName},</p>` +
                `<p>Your DentiPal account has been created.</p>` +
                `<ul>` +
                `<li><b>Email:</b> ${email}</li>` +
                `<li><b>Password:</b> ${password}</li>` + // The password
                `<li><b>Role:</b> ${subgroup}</li>` +
                (Array.isArray(clinicIds) && clinicIds.length ? `<li><b>Clinics:</b> ${clinicIds.join(", ")}</li>` : "") +
                `</ul>` +
                `<p><i>For security, please sign in and change your password immediately.</i></p>` +
                `<p>If you did not expect this email, please contact your administrator.</p>`;

            const emailParams: SendEmailCommandInput = {
                Source: "swarajparamata@gmail.com", // <-- IMPORTANT: This email MUST be verified in SES
                Destination: { ToAddresses: [email] },
                Message: {
                    Subject: { Data: subject },
                    Body: {
                        Text: { Data: textBody },
                        Html: { Data: htmlBody }
                    }
                }
            };

            await sesClient.send(new SendEmailCommand(emailParams));
            console.log(`Welcome email sent to ${email}`);
        } else {
            console.log("Skipping welcome email because sendWelcomeEmail flag was false or missing.");
        }

        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 201,
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
            }),
        };

    } catch (error) {
        // Explicitly type the error
        const err = error as Error & { name?: string; message?: string };
        console.error("Error creating user:", err);
        
        // Handle specific Cognito errors
        let statusCode = 500;
        let errorMessage = "Internal Server Error";
        let details: any = {};

        if (err.name === "UsernameExistsException") {
            statusCode = 409;
            errorMessage = "Conflict";
            details = { message: "User with this email already exists" };
        } else if (err.name === "InvalidPasswordException") {
            statusCode = 400;
            errorMessage = "Bad Request";
            details = { message: "Password does not meet requirements" };
        } else if (err.name === "NotAuthorizedException") {
            statusCode = 401;
            errorMessage = "Unauthorized";
            details = { message: "Invalid credentials or authentication failed" };
        } else if (err.name === "InvalidParameterException") {
            statusCode = 400;
            errorMessage = "Bad Request";
            details = { message: err.message || "Invalid parameters provided" };
        } else if (err.name === "LimitExceededException") {
            statusCode = 429;
            errorMessage = "Too Many Requests";
            details = { message: "Too many requests. Please try again later." };
        } else if (err.name === "InternalErrorException" || err.name === "ServiceFailureException") {
            statusCode = 503;
            errorMessage = "Service Unavailable";
            details = { message: "AWS service error. Please try again later." };
        } else {
            statusCode = 500;
            errorMessage = "Internal Server Error";
            details = { message: err.message || "An unexpected error occurred" };
        }

        return {
            statusCode,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: errorMessage,
                statusCode,
                details,
                timestamp: new Date().toISOString(),
            }),
        };
    }
};

exports.handler = handler;