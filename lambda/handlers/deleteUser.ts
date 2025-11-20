import {
    DynamoDBClient,
    ScanCommand,
    ScanCommandInput,
    UpdateItemCommand,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
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
// Import shared utils and headers
import { isRoot } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Interfaces ---

interface ResolvedUser {
    username: string;
    sub: string | null;
}

// --- Helper Functions ---

/**
 * Extracts the user identifier (email or sub) from the API Gateway path.
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

    return null;
}

/**
 * Resolves a Cognito user's username and sub given an ID.
 */
async function resolveCognitoUser(idOrSub: string): Promise<ResolvedUser | null> {
    // If looks like email (often used as the Username), use directly.
    if (idOrSub.includes("@")) {
        // We can't guarantee the sub without a lookup, so we set it to null initially.
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
 * Rewritten for AWS SDK v3.
 */
async function removeUserFromClinics(userSub: string): Promise<void> {
    const tableName = "DentiPal-Clinics"; // Or process.env.CLINICS_TABLE
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;
    const itemsToUpdate: Record<string, AttributeValue>[] = [];

    // 1. Scan to find clinics where user is associated
    do {
        const scanInput: ScanCommandInput = {
            TableName: tableName,
            // Filter for items that might contain the sub.
            FilterExpression: "contains(AssociatedUsers, :sub) OR attribute_exists(AssociatedUsers)",
            ExpressionAttributeValues: { ":sub": { S: userSub } },
            ExclusiveStartKey: lastEvaluatedKey,
        };

        const command = new ScanCommand(scanInput);
        const response = await dynamodb.send(command);

        if (response.Items) {
            for (const item of response.Items) {
                // Double check logic in memory because 'contains' works on string sets and lists
                const au = item.AssociatedUsers;
                let contains = false;

                if (au?.L) {
                    // List of Attributes
                    contains = au.L.some(attr => attr.S === userSub);
                } else if (au?.SS) {
                    // String Set
                    contains = au.SS.includes(userSub);
                }

                if (contains) {
                    itemsToUpdate.push(item);
                }
            }
        }
        lastEvaluatedKey = response.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // 2. Update each clinic
    await Promise.all(itemsToUpdate.map(async (clinic) => {
        const clinicId = clinic.clinicId?.S;
        if (!clinicId) return;

        const au = clinic.AssociatedUsers;
        try {
            if (au?.L) {
                // Case 1: List (L) - Filter and Set
                // SDK v3 List is array of AttributeValue objects
                const newList = au.L.filter((attr) => attr.S !== userSub);
                
                const updateInput: UpdateItemCommandInput = {
                    TableName: tableName,
                    Key: { clinicId: { S: clinicId } },
                    UpdateExpression: "SET AssociatedUsers = :list",
                    ExpressionAttributeValues: {
                        ":list": { L: newList }
                    }
                };
                await dynamodb.send(new UpdateItemCommand(updateInput));

            } else if (au?.SS) {
                // Case 2: String Set (SS) - Use DELETE operator
                const updateInput: UpdateItemCommandInput = {
                    TableName: tableName,
                    Key: { clinicId: { S: clinicId } },
                    UpdateExpression: "DELETE AssociatedUsers :toDel",
                    ExpressionAttributeValues: {
                        ":toDel": { SS: [userSub] }
                    }
                };
                await dynamodb.send(new UpdateItemCommand(updateInput));
            }
        } catch (e) {
            console.warn(`Failed to update clinic ${clinicId} on user removal:`, e);
        }
    }));
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization Check (Root Group)
        // Using shared isRoot utility from ./utils
        const rawGroups = event.requestContext?.authorizer?.claims?.['cognito:groups'];
        const groups = typeof rawGroups === 'string' ? rawGroups.split(',') : [];
        
        if (!isRoot(groups)) {
             return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root users can delete users",
                details: { requiredGroup: "Root" },
                timestamp: new Date().toISOString()
            });
        }

        const idOrSub = getPathId(event);
        if (!idOrSub) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "User identifier is required",
                details: { pathFormat: "/users/{email-or-sub}" },
                timestamp: new Date().toISOString()
            });
        }

        // 2. Resolve Cognito Username
        let resolved = await resolveCognitoUser(idOrSub);
        const isSubLookup = !idOrSub.includes("@");

        if (isSubLookup && !resolved) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "User not found in Cognito",
                details: { searchedBy: "sub", providedId: idOrSub },
                timestamp: new Date().toISOString()
            });
        }
        
        // If they passed an email, resolved.sub will be null, but we still have the username.
        const username = resolved?.username || idOrSub;

        // 3. Optional: Verify User Existence
        try {
            await cognito.send(
                new AdminGetUserCommand({
                    UserPoolId: process.env.USER_POOL_ID,
                    Username: username,
                })
            );
        } catch (e: any) {
            if (e?.name === "UserNotFoundException") {
                return json(404, {
                    error: "Not Found",
                    statusCode: 404,
                    message: "User does not exist in Cognito",
                    details: { username: username },
                    timestamp: new Date().toISOString()
                });
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
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "User deleted successfully",
            data: {
                deletedUsername: username,
                disassociatedFromClinics: !!subToRemove
            },
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Error deleting user:", error);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete user",
            details: { reason: error?.message },
            timestamp: new Date().toISOString()
        });
    }
};