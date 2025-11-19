import { 
    CognitoIdentityProviderClient,
    AdminUpdateUserAttributesCommand,
    AdminListGroupsForUserCommand,
    AdminRemoveUserFromGroupCommand,
    AdminAddUserToGroupCommand,
    ListUsersCommand,
    AdminGetUserCommand,
    AttributeType, // Type for user attributes in V3 SDK
    ListUsersCommandOutput,
    AdminGetUserCommandOutput,
    AdminListGroupsForUserCommandOutput
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDB } from "aws-sdk"; // Using V2 DynamoDB DocumentClient
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const USER_POOL_ID: string = process.env.USER_POOL_ID!; // Non-null assertion for env var

const cognito: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({ region: REGION });
const dynamodb = new DynamoDB.DocumentClient(); // DynamoDB DocumentClient uses simpler JS objects

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,PUT",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const VALID_SUBGROUPS: string[] = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];
const CLINICS_TABLE_NAME: string = "DentiPal-Clinics"; // Hardcoded table name

// --- 2. Type Definitions ---

interface RequestBody {
    firstName?: string;
    lastName?: string;
    phoneNumber?: string;
    subgroup?: string;
    clinicIds?: string[]; // Array of clinic IDs to associate
    email?: string;
}

interface CognitoClaims {
    'cognito:groups'?: string | string[];
    [key: string]: any;
}

interface DDBUpdateKey {
    clinicId: string;
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
 * @param clinicId - The ID of the clinic to update.
 * @param userSub - The 'sub' (User ID) of the user to associate.
 */
async function upsertUserIntoClinic(clinicId: string, userSub: string): Promise<void> {
    const params: DynamoDB.DocumentClient.UpdateItemInput = {
        TableName: CLINICS_TABLE_NAME,
        Key: { clinicId } as DDBUpdateKey, // PK is clinicId
        UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty), :toAdd)",
        ConditionExpression: "attribute_not_exists(AssociatedUsers) OR NOT contains(AssociatedUsers, :userSub)",
        ExpressionAttributeValues: {
            ":empty": [],
            ":toAdd": [userSub],
            ":userSub": userSub
        },
        ReturnValues: "UPDATED_NEW",
    };
    
    try {
        await dynamodb.update(params).promise();
    } catch (err) {
        // Ignore ConditionalCheckFailedException if userSub is already associated
        if ((err as AWS.AWSError)?.code !== "ConditionalCheckFailedException") {
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
    const path: string = event.path || event.requestContext?.path || "";
    const m = path.match(/\/users\/([^\/\?]+)/i);
    if (m?.[1]) return decodeURIComponent(m[1]);

    // 4. Last resort: use email from body
    if (bodyEmail) return String(bodyEmail); 
    
    return null;
}

// --- 4. Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({}) };
        }
        
        if (event.httpMethod !== "PUT") {
             return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: "Method not allowed. Only PUT is supported." }) };
        }

        // Auth: Check if user is Root or ClinicAdmin
        const groupsClaim: string | string[] = event.requestContext?.authorizer?.claims?.['cognito:groups'] || "";
        const groups: string[] = Array.isArray(groupsClaim) ? groupsClaim : String(groupsClaim).split(",").filter(g => g.trim().length > 0);
        
        const isRoot: boolean = groups.includes("Root");
        const isClinicAdmin: boolean = groups.includes("ClinicAdmin");
        
        if (!isRoot && !isClinicAdmin) {
            return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: "Only Root or ClinicAdmin can update users" }) };
        }

        const body: RequestBody = JSON.parse(event.body || "{}");
        const { firstName, lastName, phoneNumber, subgroup, clinicIds, email } = body;

        const username: string | null = extractUsername(event, email);
        
        if (!username) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing username/email in path or body. Expected PUT /users/{email}" }) };
        }

        // Ensure user exists (throws if not found)
        try {
            await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
        } catch (e) {
            return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `User does not exist: ${username}` }) };
        }

        // 1. Validate subgroup
        if (subgroup && !VALID_SUBGROUPS.includes(subgroup)) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: `Invalid subgroup: ${subgroup}. Valid groups are: ${VALID_SUBGROUPS.join(", ")}` }) };
        }

        // 2. Build user attributes array for Cognito update
        const attrs: AttributeType[] = [];
        if (firstName) attrs.push({ Name: "given_name", Value: firstName });
        if (lastName)  attrs.push({ Name: "family_name", Value: lastName });
        
        let e164: string | null = null;
        if (phoneNumber) {
            e164 = toE164(phoneNumber);
            if (!e164) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid phone number format. Use E.164 like +919876543210." }) };
            }
            attrs.push({ Name: "phone_number", Value: e164 });
        }

        // 3. Update Cognito attributes
        if (attrs.length) {
            await cognito.send(new AdminUpdateUserAttributesCommand({
                UserPoolId: USER_POOL_ID,
                Username: username,
                UserAttributes: attrs
            }));
        }

        // 4. Update Cognito group (if subgroup is provided)
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

        // 5. Update DynamoDB to associate user with clinics (if clinicIds are provided)
        if (Array.isArray(clinicIds) && clinicIds.length > 0) {
            const userSub: string | null = await getUserSubByUsername(username);
            
            if (!userSub) {
                return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Could not resolve user sub required for DynamoDB association" }) };
            }
            
            for (const cid of clinicIds) {
                // Optionally verify clinic existence before upserting
                const getRes = await dynamodb.get({ TableName: CLINICS_TABLE_NAME, Key: { clinicId: cid } }).promise();
                if (!getRes.Item) {
                    console.warn(`Skipping association for clinicId: ${cid}. Clinic not found.`);
                    continue; 
                }
                
                await upsertUserIntoClinic(cid, userSub);
            }
        }

        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: "success", message: "User updated successfully", username }) };
    } catch (error) {
        console.error("Error updating user:", error);
        return { 
            statusCode: 500, 
            headers: corsHeaders, 
            body: JSON.stringify({ 
                error: (error as Error)?.message || "Failed to update user due to an unexpected server error." 
            }) 
        };
    }
};