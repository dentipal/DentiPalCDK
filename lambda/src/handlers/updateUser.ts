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
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";

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

const VALID_SUBGROUPS: string[] = ["clinicadmin", "clinicmanager", "clinicviewer"];

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
    const clinicGroups: string[] = current.filter(g => VALID_SUBGROUPS.includes(g.toLowerCase()));
    
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
    setOriginFromEvent(event);
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
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const groups = userInfo.groups || [];
        
        // 2. Check if user is Root or ClinicAdmin
        const lowerGroups = groups.map((g: string) => g.toLowerCase());
        const isRootUser: boolean = lowerGroups.includes("root");
        const isClinicAdmin: boolean = lowerGroups.includes("clinicadmin");
        
        if (!isRootUser && !isClinicAdmin) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root or ClinicAdmin can update users",
                details: { requiredGroups: ["root", "clinicadmin"] },
                timestamp: new Date().toISOString()
            });
        }

        // --- Parse body ---
        let body: RequestBody;
        try {
            body = JSON.parse(event.body || "{}");
        } catch {
            return json(400, {
                error: "Invalid JSON",
                message: "Request body is not valid JSON. Please send a properly formatted JSON object.",
                timestamp: new Date().toISOString()
            });
        }

        const { firstName, lastName, subgroup, clinicIds, email: rawEmail } = body;
        const email = rawEmail ? rawEmail.toLowerCase() : undefined;

        // --- Block fields that cannot be edited ---
        if ((body as any).password || (body as any).newPassword) {
            return json(400, {
                error: "Not Editable",
                message: "Password cannot be changed through this endpoint.",
                timestamp: new Date().toISOString()
            });
        }
        if ((body as any).phoneNumber || (body as any).phone_number) {
            return json(400, {
                error: "Not Editable",
                message: "Phone number cannot be changed through this endpoint.",
                timestamp: new Date().toISOString()
            });
        }
        if ((body as any).username) {
            return json(400, {
                error: "Not Editable",
                message: "Username cannot be changed.",
                timestamp: new Date().toISOString()
            });
        }

        // --- Check at least one editable field is provided ---
        const hasFirstName = firstName !== undefined && firstName !== null;
        const hasLastName = lastName !== undefined && lastName !== null;
        const hasSubgroup = subgroup !== undefined && subgroup !== null;
        const hasClinicIds = clinicIds !== undefined && clinicIds !== null;

        if (!hasFirstName && !hasLastName && !hasSubgroup && !hasClinicIds) {
            return json(400, {
                error: "Nothing to Update",
                message: "Please provide at least one field to update.",
                editableFields: ["firstName", "lastName", "subgroup", "clinicIds"],
                timestamp: new Date().toISOString()
            });
        }

        // --- Validate firstName ---
        if (hasFirstName) {
            if (typeof firstName !== "string" || firstName.trim().length === 0) {
                return json(400, {
                    error: "Invalid First Name",
                    message: "First name must be a non-empty string.",
                    timestamp: new Date().toISOString()
                });
            }
            if (firstName.trim().length < 2) {
                return json(400, {
                    error: "Invalid First Name",
                    message: "First name must be at least 2 characters long.",
                    timestamp: new Date().toISOString()
                });
            }
            if (!/^[a-zA-Z\s'-]+$/.test(firstName.trim())) {
                return json(400, {
                    error: "Invalid First Name",
                    message: "First name can only contain letters, spaces, hyphens, and apostrophes.",
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Validate lastName ---
        if (hasLastName) {
            if (typeof lastName !== "string" || lastName.trim().length === 0) {
                return json(400, {
                    error: "Invalid Last Name",
                    message: "Last name must be a non-empty string.",
                    timestamp: new Date().toISOString()
                });
            }
            if (lastName.trim().length < 2) {
                return json(400, {
                    error: "Invalid Last Name",
                    message: "Last name must be at least 2 characters long.",
                    timestamp: new Date().toISOString()
                });
            }
            if (!/^[a-zA-Z\s'-]+$/.test(lastName.trim())) {
                return json(400, {
                    error: "Invalid Last Name",
                    message: "Last name can only contain letters, spaces, hyphens, and apostrophes.",
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Validate subgroup ---
        if (hasSubgroup) {
            if (typeof subgroup !== "string" || subgroup.trim().length === 0) {
                return json(400, {
                    error: "Invalid Subgroup",
                    message: "Subgroup must be a non-empty string.",
                    validOptions: ["ClinicAdmin", "ClinicManager", "ClinicViewer"],
                    timestamp: new Date().toISOString()
                });
            }
            if (!VALID_SUBGROUPS.includes(subgroup.toLowerCase())) {
                return json(400, {
                    error: "Invalid Subgroup",
                    message: `"${subgroup}" is not a valid role. Choose one of: ClinicAdmin, ClinicManager, ClinicViewer.`,
                    validOptions: ["ClinicAdmin", "ClinicManager", "ClinicViewer"],
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Validate clinicIds ---
        if (hasClinicIds) {
            if (!Array.isArray(clinicIds)) {
                return json(400, {
                    error: "Invalid Clinic IDs",
                    message: "clinicIds must be an array of clinic ID strings.",
                    example: { clinicIds: ["clinic-id-1", "clinic-id-2"] },
                    timestamp: new Date().toISOString()
                });
            }
            for (let i = 0; i < clinicIds.length; i++) {
                if (typeof clinicIds[i] !== "string" || clinicIds[i].trim().length === 0) {
                    return json(400, {
                        error: "Invalid Clinic ID",
                        message: `clinicIds[${i}] is invalid. Each clinic ID must be a non-empty string.`,
                        timestamp: new Date().toISOString()
                    });
                }
            }
            // Check for duplicates
            const uniqueIds = new Set(clinicIds);
            if (uniqueIds.size !== clinicIds.length) {
                return json(400, {
                    error: "Duplicate Clinic IDs",
                    message: "clinicIds contains duplicate values. Each clinic ID must be unique.",
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Resolve username ---
        const username: string | null = extractUsername(event, email);

        if (!username) {
            return json(400, {
                error: "Missing Username",
                message: "Could not determine which user to update. Provide the user's email in the URL path (PUT /users/{email}) or in the request body.",
                timestamp: new Date().toISOString()
            });
        }

        // --- Ensure user exists in Cognito ---
        try {
            await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
        } catch (e) {
            return json(404, {
                error: "User Not Found",
                message: `No user found with username "${username}" in the system. Please check the email/username and try again.`,
                timestamp: new Date().toISOString()
            });
        }

        // --- Update Cognito attributes (firstName, lastName) ---
        const attrs: AttributeType[] = [];
        if (hasFirstName) attrs.push({ Name: "given_name", Value: firstName!.trim() });
        if (hasLastName) attrs.push({ Name: "family_name", Value: lastName!.trim() });

        if (attrs.length) {
            try {
                await cognito.send(new AdminUpdateUserAttributesCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: username,
                    UserAttributes: attrs
                }));
            } catch (err: any) {
                return json(500, {
                    error: "Failed to Update Name",
                    message: `Could not update user attributes in Cognito: ${err.message}`,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Update Cognito group (subgroup) ---
        if (hasSubgroup) {
            try {
                await removeFromClinicSubgroups(username);
                await cognito.send(new AdminAddUserToGroupCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: username,
                    GroupName: subgroup!
                }));
            } catch (err: any) {
                return json(500, {
                    error: "Failed to Update Role",
                    message: `Could not update user role to "${subgroup}": ${err.message}`,
                    timestamp: new Date().toISOString()
                });
            }
        }

        // --- Update clinic assignments ---
        const notFoundClinics: string[] = [];
        const addedClinics: string[] = [];
        const removedClinics: string[] = [];

        if (hasClinicIds) {
            const userSub: string | null = await getUserSubByUsername(username);

            if (!userSub) {
                return json(500, {
                    error: "Internal Error",
                    message: "Could not find the user's internal ID (sub). This user may have been created incorrectly in Cognito.",
                    timestamp: new Date().toISOString()
                });
            }

            // Find all clinics currently associated with this user
            const { ScanCommand } = await import("@aws-sdk/client-dynamodb");
            const scanRes = await dynamodb.send(new ScanCommand({
                TableName: CLINICS_TABLE_NAME,
                FilterExpression: "contains(AssociatedUsers, :sub)",
                ExpressionAttributeValues: { ":sub": { S: userSub } },
                ProjectionExpression: "clinicId, AssociatedUsers",
            }));
            const currentClinicIds = (scanRes.Items || []).map(item => item.clinicId?.S).filter(Boolean) as string[];

            // Remove user from clinics no longer in the new list
            const newSet = new Set(clinicIds!);
            for (const oldCid of currentClinicIds) {
                if (!newSet.has(oldCid)) {
                    const oldItem = (scanRes.Items || []).find(item => item.clinicId?.S === oldCid);
                    const assocList = oldItem?.AssociatedUsers?.L || [];
                    const idx = assocList.findIndex(v => v.S === userSub);
                    if (idx >= 0) {
                        try {
                            await dynamodb.send(new UpdateItemCommand({
                                TableName: CLINICS_TABLE_NAME,
                                Key: { clinicId: { S: oldCid } },
                                UpdateExpression: `REMOVE AssociatedUsers[${idx}]`,
                            }));
                            removedClinics.push(oldCid);
                        } catch (err) {
                            console.warn(`Failed to remove user from clinic ${oldCid}:`, err);
                        }
                    }
                }
            }

            // Add user to new clinics
            for (const cid of clinicIds!) {
                const getRes = await dynamodb.send(new GetItemCommand({
                    TableName: CLINICS_TABLE_NAME,
                    Key: { clinicId: { S: cid } }
                }));

                if (!getRes.Item) {
                    notFoundClinics.push(cid);
                    continue;
                }

                await upsertUserIntoClinic(cid, userSub);
                if (!currentClinicIds.includes(cid)) {
                    addedClinics.push(cid);
                }
            }
        }

        // --- Build success response ---
        const updatedFields: string[] = [];
        if (hasFirstName) updatedFields.push("firstName");
        if (hasLastName) updatedFields.push("lastName");
        if (hasSubgroup) updatedFields.push(`role → ${subgroup}`);
        if (addedClinics.length) updatedFields.push(`added to clinics: ${addedClinics.join(", ")}`);
        if (removedClinics.length) updatedFields.push(`removed from clinics: ${removedClinics.join(", ")}`);

        const response: any = {
            status: "success",
            message: "User updated successfully.",
            updatedFields,
            data: { username },
            timestamp: new Date().toISOString()
        };

        if (notFoundClinics.length) {
            response.warnings = [`The following clinic IDs were not found and were skipped: ${notFoundClinics.join(", ")}`];
        }

        return json(200, response);

    } catch (error: any) {
        console.error("Error updating user:", error);

        if (error.message === "Authorization header missing" ||
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {

            return json(401, {
                error: "Unauthorized",
                message: "Your session has expired or your token is invalid. Please log in again.",
                details: error.message,
                timestamp: new Date().toISOString()
            });
        }

        return json(500, {
            error: "Internal Server Error",
            message: "Something went wrong while updating the user. Please try again later.",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};