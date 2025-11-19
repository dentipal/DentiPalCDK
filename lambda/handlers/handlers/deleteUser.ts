// index.ts
import { DynamoDB } from "aws-sdk"; // AWS SDK v2 for DocumentClient (older, but common)

// AWS SDK v3 for Cognito
import {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand,
    AdminGetUserCommand,
    ListUsersCommand,
    ListUsersCommandOutput,
} from "@aws-sdk/client-cognito-identity-provider";
import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
    Context,
} from "aws-lambda";

// Extend the Item interface from aws-sdk/lib/dynamodb/document_client
interface ClinicItem extends DynamoDB.DocumentClient.AttributeMap {
    clinicId: string;
    AssociatedUsers?: string[] | DynamoDB.DocumentClient.StringSet;
    // Add other clinic properties as needed
}

// Initialize the DynamoDB DocumentClient (AWS SDK v2)
const dynamodb = new DynamoDB.DocumentClient({ region: process.env.REGION });
// Initialize the Cognito Client (AWS SDK v3)
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,DELETE",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Content-Type": "application/json",
};

// --- Helper Functions ---

/**
 * Extracts the user identifier (email or sub) from the API Gateway path.
 * @param event The Lambda event object.
 * @returns The user ID string or null.
 */
function getPathId(event: APIGatewayProxyEvent): string | null {
    // 1. Prefer pathParameters.userId
    if (event.pathParameters?.userId) {
        return event.pathParameters.userId;
    }

    // 2. Handle greedy proxy: /{proxy+}
    const proxy = event.pathParameters?.proxy || "";
    if (proxy) {
        const parts = proxy.split("/").filter(Boolean);
        // expect ["users", "{id}"]
        if (parts.length >= 2 && parts[0].toLowerCase() === "users") {
            return parts[1];
        }
    }

    // 3. Fallback: try regex on raw path
    // rawPath is generally preferred in V2, path in V1
    const raw = event.path || (event as any).rawPath || "";
    const m = raw.match(/\/users\/([^/]+)(?:\/|$)/i);
    if (m && m[1]) {
        return decodeURIComponent(m[1]);
    }

    return null;
}

/**
 * Checks if the caller belongs to the 'Root' Cognito group.
 * @param event The Lambda event object.
 * @returns true if the user is in the 'Root' group.
 */
function isRootGroup(event: APIGatewayProxyEvent): boolean {
    const claims = event?.requestContext?.authorizer?.claims || {};
    let raw: string | string[] = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";

    if (Array.isArray(raw)) {
        return raw.includes("Root");
    }

    if (typeof raw === "string") {
        if (raw.trim() === "Root") return true;
        // Handle CSV case
        return raw.split(",").map(s => s.trim()).includes("Root");
    }

    return false;
}

interface ResolvedUser {
    username: string;
    sub: string | null;
}

/**
 * Resolves a Cognito user's username and sub given an ID (which can be username/email or sub).
 * @param idOrSub The user identifier provided in the path.
 * @returns An object containing the username and sub, or null if not found by sub.
 */
async function resolveCognitoUser(idOrSub: string): Promise<ResolvedUser | null> {
    // If looks like email (often used as the Username), use directly.
    if (idOrSub.includes("@")) {
        // We can't guarantee the sub without a lookup, so we set it to null.
        return { username: idOrSub, sub: null };
    }

    // Otherwise treat as sub -> find Username via ListUsers
    const cmd = new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Filter: `sub = "${idOrSub}"`,
        Limit: 1,
    });
    const out: ListUsersCommandOutput = await cognito.send(cmd);
    const user = out?.Users?.[0];

    if (!user) return null;

    const username = user.Username as string;
    let sub: string | null = null;
    for (const attr of user.Attributes || []) {
        if (attr.Name === "sub") {
            sub = attr.Value as string;
            break;
        }
    }
    return { username, sub };
}

/**
 * Removes a user's sub from the AssociatedUsers list/set in all clinics they belong to.
 * @param userSub The sub ID of the user to remove.
 */
async function removeUserFromClinics(userSub: string): Promise<void> {
    const tableName = "DentiPal-Clinics";
    let ExclusiveStartKey: DynamoDB.DocumentClient.Key | undefined;
    const toProcess: ClinicItem[] = [];

    do {
        // NOTE: Scan is inefficient. If table grows large, consider a GSI on a field
        // indicating membership, or a separate reverse index table.
        const page = await dynamodb
            .scan({
                TableName: tableName,
                // Filter for items that *might* contain the sub or have the attribute at all.
                // The contains() function only works on Lists (L) or Sets (SS/NS/BS) in DynamoDB.
                FilterExpression: "contains(AssociatedUsers, :sub) OR attribute_exists(AssociatedUsers)",
                ExpressionAttributeValues: { ":sub": userSub },
                ExclusiveStartKey,
            })
            .promise();

        for (const item of page.Items as ClinicItem[] || []) {
            const au = item.AssociatedUsers;
            let contains = false;

            if (Array.isArray(au)) { // Handles List type
                contains = au.includes(userSub);
            } else if (au && typeof au === "object" && (au as any).wrapperName === "Set") {
                // Handles String Set (SS) type via DocumentClient wrapper
                contains = ((au as any).values || []).includes(userSub);
            }

            if (contains) {
                toProcess.push(item);
            }
        }

        ExclusiveStartKey = page.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // Concurrently update each clinic to remove the user
    await Promise.all(toProcess.map(async (clinic) => {
        const clinicId = clinic.clinicId;
        if (!clinicId) return;

        const au = clinic.AssociatedUsers;

        try {
            if (Array.isArray(au)) { // Case 1: List (L)
                const newList = au.filter((s) => s !== userSub);
                await dynamodb
                    .update({
                        TableName: tableName,
                        Key: { clinicId },
                        UpdateExpression: "SET AssociatedUsers = :list",
                        ExpressionAttributeValues: { ":list": newList },
                    })
                    .promise();
            } else if (au && typeof au === "object" && (au as any).wrapperName === "Set") { // Case 2: String Set (SS)
                // Use a DELETE update on the set for efficiency
                await dynamodb
                    .update({
                        TableName: tableName,
                        Key: { clinicId },
                        UpdateExpression: "DELETE AssociatedUsers :toDel",
                        ExpressionAttributeValues: {
                            ":toDel": dynamodb.createSet([userSub]) as DynamoDB.DocumentClient.StringSet,
                        },
                    })
                    .promise();
            }
        } catch (e) {
            console.warn(`Failed to update clinic ${clinicId} on user removal:`, e);
            // Continue to the next clinic (best-effort cleanup)
        }
    }));
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    try {
        // CORS preflight
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 204, headers: CORS_HEADERS, body: "" };
        }

        // 1. Authorization Check (Root Group)
        if (!isRootGroup(event)) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Unauthorized: Only Root users can delete users" }),
            };
        }

        const idOrSub = getPathId(event);
        if (!idOrSub) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "User identifier is required in path (/users/{email-or-sub})" }),
            };
        }

        // 2. Resolve Cognito Username
        let resolved = await resolveCognitoUser(idOrSub);
        const isSubLookup = !idOrSub.includes("@");

        if (isSubLookup && !resolved) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "User not found in Cognito (by sub)" }),
            };
        }
        
        // If they passed an email, resolved.sub will be null, but we still have the username.
        const username = resolved?.username || idOrSub;

        // 3. Optional: Verify User Existence (Gives better 404 error than AdminDeleteUserCommand)
        try {
            await cognito.send(
                new AdminGetUserCommand({
                    UserPoolId: process.env.USER_POOL_ID,
                    Username: username,
                })
            );
        } catch (e: any) {
            if (e?.name === "UserNotFoundException") {
                return {
                    statusCode: 404,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "User does not exist in Cognito" }),
                };
            }
            throw e;
        }

        // 4. Delete from Cognito
        await cognito.send(
            new AdminDeleteUserCommand({
                UserPoolId: process.env.USER_POOL_ID,
                Username: username,
            })
        );

        // 5. Cleanup DynamoDB Clinics (Requires Sub)
        let subToRemove: string | null = resolved?.sub || null;
        
        // If we didn't find the sub (because the caller passed an email), we do a final lookup by email.
        if (!subToRemove) {
            try {
                const listByEmail = await cognito.send(
                    new ListUsersCommand({
                        UserPoolId: process.env.USER_POOL_ID,
                        Filter: `email = "${idOrSub}"`,
                        Limit: 1,
                    })
                );
                const u = listByEmail?.Users?.[0];
                const subAttr = (u?.Attributes || []).find((a) => a.Name === "sub");
                subToRemove = subAttr?.Value || null;
            } catch {
                console.warn("Could not perform final lookup by email to retrieve sub for cleanup.");
            }
        }

        if (subToRemove) {
            await removeUserFromClinics(subToRemove);
        } else {
            console.warn(`Could not determine 'sub' for user ${idOrSub}. DynamoDB cleanup skipped.`);
        }

        // 6. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                message: "User deleted from Cognito and disassociated from clinics",
            }),
        };
    } catch (error: any) {
        console.error("Error deleting user:", error);
        return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: error?.message || "Failed to delete user" }),
        };
    }
};