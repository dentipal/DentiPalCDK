import {
    CognitoIdentityProviderClient,
    ConfirmForgotPasswordCommand,
    ListUsersCommand,
    ConfirmForgotPasswordCommandInput,
    ListUsersCommandInput,
    UserType, // Type for ListUsersCommand output
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the Cognito Identity Provider Client
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the expected structure for the request body
interface RequestBody {
    email?: string;
    code?: string;
    newPassword?: string;
}

// Helper: resolve Cognito Username from email when your pool does NOT use email-as-username
async function findUsernameByEmail(userPoolId: string, emailLower: string): Promise<string | null> {
    console.log("[confirm] findUsernameByEmail:", emailLower);

    const listUsersInput: ListUsersCommandInput = {
        UserPoolId: userPoolId,
        Filter: `email = "${emailLower}"`,
        Limit: 2,
    };

    const r = await cognito.send(new ListUsersCommand(listUsersInput));
    
    // Type checking and safe access to the first user
    const users: UserType[] = r.Users || [];
    const u = users[0];

    console.log("[confirm] ListUsers count:", users.length, "picked username:", u?.Username);
    return u?.Username || null;
}

// Define the Lambda handler function
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log("=== /auth/confirm-forgot-password START ===");
    console.log("[req] method:", event?.httpMethod);
    console.log("[req] headers:", JSON.stringify(event?.headers || {}));
    console.log("[req] body:", event?.body);

    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";
    
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Parse the request body, safely handling potential null/undefined body
        const body: RequestBody = JSON.parse(event.body || "{}");
        const { email, code, newPassword } = body;

        console.log("[confirm] parsed:", { email, hasCode: !!code, hasPw: !!newPassword });

        // Input validation
        if (!email || !code || !newPassword) {
            console.warn("[confirm] missing fields");
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Email, verification code, and new password are required",
                details: {
                    missingFields: [
                        !email && "email",
                        !code && "code",
                        !newPassword && "newPassword"
                    ].filter(Boolean)
                },
                timestamp: new Date().toISOString()
            });
        }

        const emailLower: string = String(email).toLowerCase();
        let username: string = emailLower;

        // Conditional logic for username lookup if email-as-username is not used
        if (process.env.EMAIL_IS_USERNAME !== "true") {
            const userPoolId = process.env.USER_POOL_ID;
            if (!userPoolId) {
                console.error("[confirm] Missing USER_POOL_ID for username lookup");
                return json(500, {
                    error: "Internal Server Error",
                    statusCode: 500,
                    message: "Server configuration error. Please contact support.",
                    details: { issue: "Missing USER_POOL_ID environment variable" },
                    timestamp: new Date().toISOString()
                });
            }
            
            const foundUsername = await findUsernameByEmail(userPoolId, emailLower);
            // Fallback to emailLower if username is not found via ListUsers
            username = foundUsername || emailLower;
        }

        console.log("[confirm] using username:", username);

        // Prepare the command input
        const confirmForgotInput: ConfirmForgotPasswordCommandInput = {
            ClientId: process.env.CLIENT_ID, // your app client id
            Username: username,
            ConfirmationCode: code,
            Password: newPassword
        };

        const cmd = new ConfirmForgotPasswordCommand(confirmForgotInput);

        // Send the command to Cognito
        await cognito.send(cmd);
        console.log("[confirm] success for:", username);

        // Successful response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Password reset successful",
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        // Explicitly type the error
        const error = err as Error & { name?: string };
        console.error("[confirm] ERROR:", error?.name, error?.message);

        // Friendly error mapping (copied exactly from original JS)
        const name: string = error?.name || "";
        let message: string;
        let status: number;
        let details: Record<string, any> = { errorType: name, reason: error?.message };

        // Determine friendly message and status code
        switch (name) {
            case "CodeMismatchException":
                message = "Invalid verification code";
                status = 400;
                details.suggestion = "Please verify the code and try again";
                break;
            case "ExpiredCodeException":
                message = "Verification code expired";
                status = 400;
                details.suggestion = "Request a new password reset code";
                break;
            case "UserNotFoundException":
                message = "User account not found";
                status = 404;
                details.suggestion = "Check the email address and try again";
                break;
            case "InvalidParameterException":
                message = "Password does not meet requirements";
                status = 400;
                details.suggestion = "Ensure password meets policy requirements (length, complexity)";
                break;
            case "LimitExceededException":
                message = "Too many attempts";
                status = 429;
                details.suggestion = "Please try again later";
                break;
            default:
                message = "Password reset failed";
                status = 500;
                break;
        }

        // Return error response
        return json(status, {
            error: status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : status === 404 ? "Not Found" : status === 429 ? "Too Many Requests" : "Internal Server Error",
            statusCode: status,
            message: message,
            details: details,
            timestamp: new Date().toISOString()
        });
    }
};