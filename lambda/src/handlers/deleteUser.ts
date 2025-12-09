import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
    DynamoDBDocumentClient, 
    ScanCommand, 
    ScanCommandInput, 
    UpdateCommand,
    UpdateCommandInput 
} from "@aws-sdk/lib-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminDeleteUserCommand,
    AdminGetUserCommand,
    ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---
const REGION = process.env.REGION || "us-east-1";
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);
const cognito = new CognitoIdentityProviderClient({ region: REGION });

// Helper
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

interface ResolvedUser {
    username: string;
    sub: string | null;
}

// --- Helper Functions ---

function getPathId(event: APIGatewayProxyEvent): string | null {
    if (event.pathParameters?.userId) {
        return event.pathParameters.userId;
    }
    const proxy = event.pathParameters?.proxy || "";
    if (proxy) {
        const parts = proxy.split("/").filter(Boolean);
        if (parts.length >= 2 && parts[0].toLowerCase() === "users") {
            return parts[1];
        }
    }
    return null;
}

async function resolveCognitoUser(idOrSub: string): Promise<ResolvedUser | null> {
    if (idOrSub.includes("@")) {
        return { username: idOrSub, sub: null };
    }

    const cmd = new ListUsersCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Filter: `sub = "${idOrSub}"`,
        Limit: 1,
    });
    const out = await cognito.send(cmd);
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

async function removeUserFromClinics(userSub: string): Promise<void> {
    const tableName = process.env.CLINICS_TABLE || "DentiPal-Clinics";
    let lastEvaluatedKey: Record<string, any> | undefined;
    const itemsToUpdate: Record<string, any>[] = [];

    // 1. Scan to find clinics
    do {
        const scanInput: ScanCommandInput = {
            TableName: tableName,
            // Filter for items that might contain the sub (works for List or String Set)
            FilterExpression: "contains(AssociatedUsers, :sub) OR attribute_exists(AssociatedUsers)",
            ExpressionAttributeValues: { ":sub": userSub },
            ExclusiveStartKey: lastEvaluatedKey,
        };

        const command = new ScanCommand(scanInput);
        const response = await ddbDoc.send(command);

        if (response.Items) {
            for (const item of response.Items) {
                const au = item.AssociatedUsers;
                let contains = false;

                // Check Array (List) or String Set
                if (Array.isArray(au)) {
                    contains = au.includes(userSub);
                } else if (au instanceof Set) {
                    contains = au.has(userSub);
                } else if (typeof au === 'object' && au.values) { 
                    // Sometimes Sets come as object wrappers depending on SDK version nuances
                    // but ddbDoc usually handles native Set/Array
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
        const clinicId = clinic.clinicId;
        if (!clinicId) return;

        const au = clinic.AssociatedUsers;
        try {
            if (Array.isArray(au)) {
                // List: Filter and Set
                const newList = au.filter((val: string) => val !== userSub);
                const updateInput: UpdateCommandInput = {
                    TableName: tableName,
                    Key: { clinicId: clinicId },
                    UpdateExpression: "SET AssociatedUsers = :list",
                    ExpressionAttributeValues: {
                        ":list": newList
                    }
                };
                await ddbDoc.send(new UpdateCommand(updateInput));

            } else {
                // Set: DELETE operator
                const updateInput: UpdateCommandInput = {
                    TableName: tableName,
                    Key: { clinicId: clinicId },
                    UpdateExpression: "DELETE AssociatedUsers :toDel",
                    ExpressionAttributeValues: {
                        ":toDel": new Set([userSub])
                    }
                };
                await ddbDoc.send(new UpdateCommand(updateInput));
            }
        } catch (e) {
            console.warn(`Failed to update clinic ${clinicId} on user removal:`, e);
        }
    }));
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization Check (Root Group via Access Token)
        let userGroups: string[] = [];
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }
        
        if (!userGroups.includes("root")) {
             return json(403, {
                error: "Forbidden",
                message: "Only Root users can delete users",
                details: { requiredGroup: "Root" }
            });
        }

        const idOrSub = getPathId(event);
        if (!idOrSub) {
            return json(400, {
                error: "Bad Request",
                message: "User identifier is required",
                details: { pathFormat: "/users/{email-or-sub}" }
            });
        }

        // 2. Resolve Cognito Username
        let resolved = await resolveCognitoUser(idOrSub);
        const isSubLookup = !idOrSub.includes("@");

        if (isSubLookup && !resolved) {
            return json(404, {
                error: "Not Found",
                message: "User not found in Cognito",
                details: { searchedBy: "sub", providedId: idOrSub }
            });
        }
        
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
                    message: "User does not exist in Cognito",
                    details: { username: username }
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

        // 5. Cleanup DynamoDB Clinics
        let subToRemove: string | null = resolved?.sub || null;
        
        // Final lookup by email if sub was not found
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

        // 6. Success
        return json(200, {
            status: "success",
            message: "User deleted successfully",
            data: {
                deletedUsername: username,
                disassociatedFromClinics: !!subToRemove
            }
        });

    } catch (error: any) {
        console.error("Error deleting user:", error);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to delete user",
            details: { reason: error?.message }
        });
    }
};