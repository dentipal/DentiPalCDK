import {
    CognitoIdentityProviderClient,
    AdminAddUserToGroupCommand,
    AdminCreateUserCommand,
    AdminSetUserPasswordCommand,
    AdminCreateUserCommandInput,
    AdminAddUserToGroupCommandInput,
    AdminSetUserPasswordCommandInput,
    AttributeType, // Type for user attributes in Cognito
} from "@aws-sdk/client-cognito-identity-provider";
import { 
    DynamoDBClient, 
    UpdateItemCommand, 
    UpdateItemCommandInput,
    GetItemCommand,
    GetItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { 
    SESClient, 
    SendEmailCommand, 
    SendEmailCommandInput 
} from "@aws-sdk/client-ses";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// --- Initialization (using V3 clients) ---
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";

const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamodbClient = new DynamoDBClient({ region: REGION }); // Using DynamoDBClient (v3)
const sesClient = new SESClient({ region: REGION }); // Using SESClient (v3)

// Define shared CORS headers
const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,POST,GET",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
};

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
            return {
                statusCode: 200,
                headers: corsHeaders,
                body: JSON.stringify({}),
            };
        }

        // 1️⃣ Verify Root User Authorization
        // Note: The original JS uses event.requestContext?.authorizer?.claims?.['cognito:groups']
        // which returns a string or array depending on the API Gateway type. We assume an array for simplicity,
        // but handle the case where it might be a comma-separated string if needed (though the original check assumes array).
        const userGroups: string[] = (event.requestContext?.authorizer?.claims?.['cognito:groups'] as string[] | string) || [];
        const groupsArray = Array.isArray(userGroups) ? userGroups : String(userGroups).split(',').map(s => s.trim());
        
        if (!groupsArray.includes("Root")) {
            console.warn("Unauthorized user tried to add new user:", groupsArray);
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Unauthorized: Only Root users can add new users" }),
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
                headers: corsHeaders,
                body: JSON.stringify({ error: "Passwords do not match" }),
            };
        }

        // Validate required fields
        if (!firstName || !lastName || !phoneNumber || !email || !password || !subgroup || !clinicIds || clinicIds.length === 0) {
            console.error("Missing required fields:", { firstName, lastName, phoneNumber, email, password, subgroup, clinicIds });
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Missing required fields" }),
            };
        }

        // Validate the subgroup
        const validGroups = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
        if (!validGroups.includes(subgroup)) {
            console.error("Invalid subgroup:", subgroup);
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Invalid subgroup" }),
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
        const CLINICS_TABLE_NAME = "DentiPal-Clinics"; // Table name is hardcoded in JS

        for (const clinicId of clinicIds) {
            // Check if the user is already associated (optional, but safer)
            // The original JS only performed a get to check existence before updating, 
            // but the update logic doesn't strictly need the get.
            
            // The UpdateItemCommand below implements the original DocumentClient logic:
            // UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty_list), :userSub)"
            // This appends the new userSub to the list, initializing the list if it doesn't exist.
            
            const clinicUpdateParams: UpdateItemCommandInput = {
                TableName: CLINICS_TABLE_NAME,
                Key: { clinicId: { S: clinicId } }, // Key must be typed for V3 client
                UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty_list), :userSub)",
                ExpressionAttributeValues: {
                    ":userSub": { L: [{ S: userSub }] }, // Append a list containing the new userSub
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
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                status: "success",
                message: "User created successfully and associated with clinic(s).",
                userSub: userSub,
            }),
        };

    } catch (error) {
        // Explicitly type the error
        const err = error as Error & { name?: string; message?: string };
        console.error("Error:", err);
        
        // Provide more specific error messages
        let errorMessage = err.message || "An unknown error occurred";
        let statusCode = 400; // Default to 400 for client-related errors

        if (err.name === "UsernameExistsException") {
            errorMessage = "A user with this email already exists.";
        } else if (err.name === "InvalidPasswordException") {
            errorMessage = "Password does not meet the requirements.";
        } else if (err.name === "NotAuthorizedException") {
             errorMessage = "Unauthorized access or incorrect credentials.";
             statusCode = 401;
        } else if (err.name === "InternalErrorException") {
             statusCode = 500;
        }

        return {
            statusCode: statusCode,
            headers: corsHeaders,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};

exports.handler = handler;