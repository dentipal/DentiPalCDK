import { 
    CognitoIdentityProviderClient, 
    AdminUpdateUserAttributesCommand, 
    AdminListGroupsForUserCommand, 
    AdminRemoveUserFromGroupCommand, 
    AdminAddUserToGroupCommand, 
    ListUsersCommand, 
    AdminGetUserCommand, 
    AttributeType,
    ListUsersCommandOutput,
    AdminGetUserCommandOutput,
    AdminListGroupsForUserCommandOutput
} from "@aws-sdk/client-cognito-identity-provider";
import { 
    DynamoDBClient, 
    UpdateItemCommand, 
    UpdateItemCommandInput,
    GetItemCommand,
    GetItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const USER_POOL_ID: string = process.env.USER_POOL_ID!; // Non-null assertion for env var
const CLINICS_TABLE_NAME: string = process.env.CLINICS_TABLE || "DentiPal-Clinics";

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const dynamodb = new DynamoDBClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const VALID_SUBGROUPS: string[] = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];

// --- 2. Type Definitions ---

interface RequestBody {
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    subgroup?: string;
    clinicIds?: string[]; // Array of clinic IDs to associate
    email?: string;
}

// --- 3. Utility Functions ---

/**
 * E.164 sanitizer: Converts raw phone number string to E.164 format (e.g., +1234567890).
 * @param raw - The raw phone number string.
 * @returns The sanitized E.164 string or null if invalid format.
 */
function toE164(raw: string | undefined): string | null {
    if (!raw) return null;
    const digits: string = String(raw).replace(/[^\d+]/g, "");
    // Remove duplicate leading '+' characters, ensuring only one '+' is at the start
    const cleaned: string = digits.replace(/\++/g, "+").replace(/(?!^)\+/g, "");
    
    // Validate E.164 format: starts with '+', followed by 8 to 15 digits
    if (!/^\+\d{8,15}$/.test(cleaned)) return null;
    return cleaned;
}

/**
 * Attempts to retrieve a user's 'sub' attribute by username (email) using AdminGetUser or ListUsers.
 * @param username - The Cognito Username (typically the user's email).
 * @returns The user's 'sub' (User ID) string or null.
 */
async function getUserSubByUsername(username: string): Promise<string | null> {
    const subName = "sub";
    
    // Strategy 1: Use AdminGetUser (Fastest if username matches email)
    try {
        const res: AdminGetUserCommandOutput = await cognito.send(new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
        }));
        const subAttr = res.UserAttributes?.find(a => a.Name === subName);
        return subAttr?.Value || null;
    } catch (adminGetError) {
        // Strategy 2: Fallback to ListUsers filtering by email (necessary if username is cognito:user_id)
        try {
            const res: ListUsersCommandOutput = await cognito.send(new ListUsersCommand({
                UserPoolId: USER_POOL_ID,
                Filter: `email = "${username}"`,
                Limit: 1
            }));
            const user = res.Users?.[0];
            const subAttr = user?.Attributes?.find(a => a.Name === subName);
            return subAttr?.Value || null;
        } catch (listUsersError) {
            console.error(`Failed to find user sub for ${username} via both AdminGet and ListUsers.`, listUsersError);
            return null;
        }
    }
}

/**
 * Removes a user from any valid clinic-related subgroups (e.g., ClinicAdmin, ClinicViewer).
 * @param username - The Cognito Username.
 */
async function removeFromClinicSubgroups(username: string): Promise<void> {
    const res: AdminListGroupsForUserCommandOutput = await cognito.send(new AdminListGroupsForUserCommand({
        UserPoolId: USER_POOL_ID,
        Username: username
    }));
    
    const current: string[] = res.Groups?.map(g => g.GroupName || '') || [];
    const clinicGroups: string[] = current.filter(g => VALID_SUBGROUPS.includes(g));
    
    for (const groupName of clinicGroups) {
        await cognito.send(new AdminRemoveUserFromGroupCommand({
            UserPoolId: USER_POOL_ID,
            Username: username,
            GroupName: groupName
        }));
    }
}

/**
 * Updates the DentiPal-Clinics table to ensure the userSub is listed in the AssociatedUsers array.
 * Uses a conditional update to append the userSub only if it's not already present.
 * Migrated to AWS SDK v3 syntax (using AttributeValues like { S: string }, { L: list }).
 * @param clinicId - The ID of the clinic to update.
 * @param userSub - The 'sub' (User ID) of the user to associate.
 */
async function upsertUserIntoClinic(clinicId: string, userSub: string): Promise<void> {
    const params: UpdateItemCommandInput = {
        TableName: CLINICS_TABLE_NAME,
        Key: { clinicId: { S: clinicId } },
        // Use list_append to add the userSub to the AssociatedUsers list
        UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty), :toAdd)",
        // Only update if the user is NOT already in the list
        ConditionExpression: "attribute_not_exists(AssociatedUsers) OR NOT contains(AssociatedUsers, :userSub)",
        ExpressionAttributeValues: {
            ":empty": { L: [] }, // Empty list for initialization
            ":toAdd": { L: [{ S: userSub }] }, // List containing the new userSub
            ":userSub": { S: userSub } // String value for the contains check
        },
        ReturnValues: "UPDATED_NEW",
    };
    
    try {
        await dynamodb.send(new UpdateItemCommand(params));
    } catch (err: any) {
        // Ignore ConditionalCheckFailedException if userSub is already associated
        if (err.name !== "ConditionalCheckFailedException") {
            throw err;
        }
    }
}

/**
 * Extracts the username (email) from various possible API Gateway path structures.
 * @param event - The APIGatewayProxyEvent.
 * @param bodyEmail - Email provided in the request body as a fallback.
 * @returns The decoded username string or null.
 */
function extractUsername(event: APIGatewayProxyEvent, bodyEmail: string | undefined): string | null {
    // 1. Check direct path parameter {userId}
    const direct: string | undefined = event.pathParameters?.userId;
    if (direct) return decodeURIComponent(direct);

    // 2. Check proxy path parameter {proxy+} (e.g., "users/jane@example.com")
    const proxy: string | undefined = event.pathParameters?.proxy; 
    if (proxy && proxy.startsWith("users/")) {
        const rest: string = proxy.slice(6);
        if (rest) return decodeURIComponent(rest);
    }

    // 3. Check full path via regex (e.g., /staging/users/jane@example.com)
    const path: string = event.path || (event.requestContext as any)?.path || "";
    const m = path.match(/\/users\/([^\/\?]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]);

    // 4. Last resort: use email from body
    if (bodyEmail) return String(bodyEmail); 
    
    return null;
}

// --- 4. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }
    
    if (method !== "PUT") {
         return json(405, {
            error: "Method Not Allowed",
            statusCode: 405,
            message: "Only PUT method is supported",
            details: { allowedMethods: ["PUT"] },
            timestamp: new Date().toISOString()
         });
    }

    try {
        // Auth: Check if user is Root or ClinicAdmin
        // Handle various structures of claims
        const claims = (event.requestContext.authorizer as any)?.claims;
        const groupsClaim: string | string[] = claims?.['cognito:groups'] || "";
        const groups: string[] = Array.isArray(groupsClaim) ? groupsClaim : String(groupsClaim).split(",").filter(g => g.trim().length > 0);
        
        const isRootUser: boolean = groups.includes("Root");
        const isClinicAdmin: boolean = groups.includes("ClinicAdmin");
        
        if (!isRootUser && !isClinicAdmin) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root or ClinicAdmin can update users",
                details: { requiredGroups: ["Root", "ClinicAdmin"] },
                timestamp: new Date().toISOString()
            });
        }

        const body: RequestBody = JSON.parse(event.body || "{}");
        const { firstName, lastName, phoneNumber, subgroup, clinicIds, email } = body;

        const username: string | null = extractUsername(event, email);
        
        if (!username) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Username or email is required",
                details: { pathFormat: "PUT /users/{email}" },
                timestamp: new Date().toISOString()
            });
        }

        // Ensure user exists (throws if not found)
        try {
            await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
        } catch (e) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "User does not exist",
                details: { username: username },
                timestamp: new Date().toISOString()
            });
        }

        // 1. Validate subgroup
        if (subgroup && !VALID_SUBGROUPS.includes(subgroup)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: `Invalid subgroup: ${subgroup}`,
                details: { validGroups: VALID_SUBGROUPS },
                timestamp: new Date().toISOString()
            });
        }

        // 2. Build user attributes array for Cognito update
        const attrs: AttributeType[] = [];
        if (firstName) attrs.push({ Name: "given_name", Value: firstName });
        if (lastName)  attrs.push({ Name: "family_name", Value: lastName });
        
        if (phoneNumber) {
            const e164 = toE164(phoneNumber);
            if (!e164) {
                return json(400, {
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Invalid phone number format",
                    details: { format: "E.164 format (e.g., +919876543210)", received: phoneNumber },
                    timestamp: new Date().toISOString()
                });
            }
            attrs.push({ Name: "phone_number", Value: e164 });
        }

        // 3. Validate clinicIds if provided
        if (clinicIds && !Array.isArray(clinicIds)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "clinicIds must be an array",
                details: { expected: "Array of clinic IDs" },
                timestamp: new Date().toISOString()
            });
        }
        
        // 4. Update Cognito attributes if any were collected
        if (attrs.length) {
            await cognito.send(new AdminUpdateUserAttributesCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
                UserAttributes: attrs
            }));
        }

        // 5. Update Cognito group (if subgroup is provided)
        if (subgroup) {
            // Remove from all existing clinic groups first
            await removeFromClinicSubgroups(username);
            
            // Add to the new subgroup
            await cognito.send(new AdminAddUserToGroupCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
                GroupName: subgroup
            }));
        }

        // 6. Update DynamoDB to associate user with clinics (if clinicIds are provided)
        if (Array.isArray(clinicIds) && clinicIds.length > 0) {
            const userSub: string | null = await getUserSubByUsername(username);
            
            if (!userSub) {
                return json(400, {
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Could not resolve user sub required for clinic association",
                    details: { username: username },
                    timestamp: new Date().toISOString()
                });
            }
            
            for (const cid of clinicIds) {
                // Optionally verify clinic existence before upserting
                const getParams: GetItemCommandInput = {
                    TableName: CLINICS_TABLE_NAME,
                    Key: { clinicId: { S: cid } }
                };
                const getRes = await dynamodb.send(new GetItemCommand(getParams));

                if (!getRes.Item) {
                    console.warn(`Skipping association for clinicId: ${cid}. Clinic not found.`);
                    continue; 
                }
                
                await upsertUserIntoClinic(cid, userSub);
            }
        }

        return json(200, {
            status: "success",
            statusCode: 200,
            message: "User updated successfully",
            data: { username },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        console.error("Error updating user:", error);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to update user",
            details: { reason: (error as Error)?.message },
            timestamp: new Date().toISOString()
        });
    }
};