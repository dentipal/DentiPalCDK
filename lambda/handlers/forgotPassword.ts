import {
    CognitoIdentityProviderClient,
    ListUsersCommand,
    AdminListGroupsForUserCommand,
    ForgotPasswordCommand,
    ListUsersCommandOutput,
    AdminListGroupsForUserCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the Cognito client (AWS SDK v3)
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });



// Configure group mapping via env (no hardcoding in code)
const CLINIC_GROUPS: string[] = (process.env.CLINIC_GROUPS || "Root,ClinicAdmin,ClinicManager,ClinicViewer")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

const PRO_GROUPS: string[] = (process.env.PRO_GROUPS || "AssociateDentist,DentalHygienist,DentalAssistant,FrontDesk")
    .split(",")
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

// Sets for O(1) group lookup performance
const CLINIC_SET: Set<string> = new Set(CLINIC_GROUPS);
const PRO_SET: Set<string> = new Set(PRO_GROUPS);

// Environment variables
const EMAIL_IS_USERNAME: boolean = process.env.EMAIL_IS_USERNAME === "true";
const USER_POOL_ID: string | undefined = process.env.USER_POOL_ID;
const CLIENT_ID: string | undefined = process.env.CLIENT_ID;

// Define expected body structure
interface ForgotPasswordRequestBody {
    email?: string;
    expectedUserType?: 'clinic' | 'professional';
}

// --- helpers ---

/**
 * Finds the Cognito Username associated with an email address.
 * Uses a ListUsers query if EMAIL_IS_USERNAME is false.
 * @param emailLower The email address, lowercased.
 * @returns The Cognito username or null.
 */
async function findUsernameByEmail(emailLower: string): Promise<string | null> {
    if (EMAIL_IS_USERNAME) return emailLower;

    if (!USER_POOL_ID) {
        throw new Error("USER_POOL_ID environment variable is not set.");
    }

    const response: ListUsersCommandOutput = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${emailLower}"`,
        Limit: 2,
    }));
    
    const u = (response.Users || [])[0];
    return u?.Username || null;
}

/**
 * Retrieves the list of groups a user belongs to.
 * @param username The Cognito username.
 * @returns An array of group names.
 */
async function getGroups(username: string): Promise<string[]> {
    if (!USER_POOL_ID) {
        throw new Error("USER_POOL_ID environment variable is not set.");
    }

    const response: AdminListGroupsForUserCommandOutput = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
    }));
    
    return (response.Groups || []).map(g => g.GroupName as string);
}

/**
 * Derives the user type (clinic, professional, or unknown) based on their Cognito groups.
 * @param groups An array of group names.
 * @returns 'clinic', 'professional', or 'unknown'.
 */
function deriveUserTypeFromGroups(groups: string[]): 'clinic' | 'professional' | 'unknown' {
    const lower = groups.map(g => g.toLowerCase());
    
    if (lower.some(g => CLINIC_SET.has(g) || g.includes("clinic"))) return "clinic";
    if (lower.some(g => PRO_SET.has(g))) return "professional";
    
    return "unknown";
}

// --- handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log("=== /auth/forgot START ===");
    
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "{}" };
    }

    try {
        const body: ForgotPasswordRequestBody = JSON.parse(event.body || "{}");
        const { email, expectedUserType } = body;
        
        console.log("[forgot] input:", { email, expectedUserType });

        if (!email) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: "Email is required",
                    statusCode: 400,
                    timestamp: new Date().toISOString(),
                }),
            };
        }
        if (!CLIENT_ID || !USER_POOL_ID) {
            console.error("[forgot] missing env CLIENT_ID or USER_POOL_ID");
            return {
                statusCode: 500,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Internal Server Error",
                    message: "Server configuration error",
                    statusCode: 500,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        const emailLower = String(email).toLowerCase();

        // 1) Resolve username
        const username = await findUsernameByEmail(emailLower);
        console.log("[forgot] resolved username:", username);
        
        if (!username) {
            // Return generic success to prevent email enumeration attack
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    status: "success",
                    statusCode: 200,
                    message: "If the email exists in our system, a password reset code has been sent.",
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // 2) Determine userType from groups
        let groups: string[] = [];
        try {
            groups = await getGroups(username);
        } catch (e: any) {
            console.warn("[forgot] AdminListGroupsForUser failed:", e?.name, e?.message);
            return {
                statusCode: 500,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Internal Server Error",
                    message: "Failed to retrieve user role information",
                    statusCode: 500,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        const userType = deriveUserTypeFromGroups(groups);
        console.log("[forgot] groups:", groups, "→ userType:", userType);

        // 3) Enforce side if provided
        if (expectedUserType && userType !== "unknown" && userType !== expectedUserType) {
            // e.g., user is clinic but tried to reset on professional side
            const portalType = userType === "clinic" ? "Clinic" : "Professional";
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: `This account is a ${userType} account. Please use the ${portalType} portal.`,
                    statusCode: 400,
                    accountType: userType,
                    timestamp: new Date().toISOString(),
                })
            };
        }

        // 4) Send the code
        await cognito.send(new ForgotPasswordCommand({
            ClientId: CLIENT_ID,
            Username: username, // use resolved username
        }));

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 200,
                message: "If the email exists in our system, a password reset code has been sent.",
                timestamp: new Date().toISOString(),
            })
        };
    } catch (err: any) {
        console.error("[forgot] ERROR:", err?.name, err?.message);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "An error occurred while initiating the password reset. Please try again." })
        };
    }
};