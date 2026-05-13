import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from "aws-lambda";
import {
    QueryCommand,
    DeleteItemCommand,
    BatchWriteItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { corsHeaders } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";
import { ddb, NOTIFICATIONS_TABLE } from "./notifications";

const json = (event: APIGatewayProxyEvent, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface RequestBody {
    ids?: string[] | "all";
}

const BATCH_DELETE_CHUNK = 25; // DynamoDB BatchWriteItem hard cap

/**
 * POST /notifications/delete
 * Body: { ids: ["nid-1","nid-2"] } — delete specific notifications
 *       { ids: "all" }              — delete every notification for the caller
 *
 * Removes rows from DentiPal-V5-Notifications. The frontend calls this after
 * the user opens a notification so it disappears from the feed. The 90-day
 * TTL is the long-term cleanup — this is the user-driven path.
 */
export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        const body: RequestBody = event.body ? JSON.parse(event.body) : {};
        const target = body.ids;

        if (!target) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Body must include `ids` (array of notificationIds or the string \"all\").",
            });
        }

        let idsToDelete: string[] = [];

        if (target === "all") {
            // Pull every notificationId for this user — paginate so we can
            // empty an arbitrarily large inbox in one call.
            let lastKey: Record<string, AttributeValue> | undefined;
            do {
                const result = await ddb.send(new QueryCommand({
                    TableName: NOTIFICATIONS_TABLE,
                    KeyConditionExpression: "userSub = :u",
                    ExpressionAttributeValues: { ":u": { S: userSub } },
                    ProjectionExpression: "notificationId",
                    ExclusiveStartKey: lastKey,
                }));
                for (const item of result.Items || []) {
                    const id = item.notificationId?.S;
                    if (id) idsToDelete.push(id);
                }
                lastKey = result.LastEvaluatedKey;
            } while (lastKey);
        } else if (Array.isArray(target)) {
            idsToDelete = target.filter((x): x is string => typeof x === "string" && !!x);
        } else {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "`ids` must be an array of strings or the literal \"all\".",
            });
        }

        // Batch delete in chunks of 25 (DynamoDB limit). For very small
        // single-row deletes the loop is fine; for "all" with many rows
        // this batches them up.
        for (let i = 0; i < idsToDelete.length; i += BATCH_DELETE_CHUNK) {
            const chunk = idsToDelete.slice(i, i + BATCH_DELETE_CHUNK);
            if (chunk.length === 1) {
                // Single delete avoids the BatchWriteItem overhead.
                await ddb.send(new DeleteItemCommand({
                    TableName: NOTIFICATIONS_TABLE,
                    Key: {
                        userSub: { S: userSub },
                        notificationId: { S: chunk[0] },
                    },
                }));
            } else {
                await ddb.send(new BatchWriteItemCommand({
                    RequestItems: {
                        [NOTIFICATIONS_TABLE]: chunk.map((notificationId) => ({
                            DeleteRequest: {
                                Key: {
                                    userSub: { S: userSub },
                                    notificationId: { S: notificationId },
                                },
                            },
                        })),
                    },
                }));
            }
        }

        // Return the post-delete unread count so the bell badge can update.
        const remaining = await ddb.send(new QueryCommand({
            TableName: NOTIFICATIONS_TABLE,
            KeyConditionExpression: "userSub = :u",
            ExpressionAttributeValues: { ":u": { S: userSub } },
            FilterExpression: "attribute_not_exists(readAt)",
            Select: "COUNT",
            Limit: 100,
        }));

        return json(event, 200, {
            deleted: idsToDelete.length,
            unreadCount: remaining.Count || 0,
        });
    } catch (err: any) {
        const message = err?.message || "Failed to delete notifications";
        if (message.toLowerCase().includes("token")) {
            return json(event, 401, {
                error: "Unauthorized",
                statusCode: 401,
                message,
            });
        }
        console.error("[deleteNotifications] error:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message,
        });
    }
};
