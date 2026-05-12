import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from "aws-lambda";
import {
    QueryCommand,
    UpdateItemCommand,
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

/**
 * POST /notifications/read
 * Body: { ids: ["nid-1","nid-2"] }  — mark specific notifications
 *       { ids: "all" }              — mark every unread notification for the caller
 *
 * Sets `readAt` to the current ISO timestamp on each affected row. Idempotent
 * — re-marking an already-read row keeps the original timestamp.
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

        let idsToUpdate: string[] = [];

        if (target === "all") {
            // Pull every unread notificationId for this user — paginate so we
            // can mark the whole inbox in one call without hitting a 1MB cap.
            let lastKey: Record<string, AttributeValue> | undefined;
            do {
                const result = await ddb.send(new QueryCommand({
                    TableName: NOTIFICATIONS_TABLE,
                    KeyConditionExpression: "userSub = :u",
                    ExpressionAttributeValues: { ":u": { S: userSub } },
                    FilterExpression: "attribute_not_exists(readAt)",
                    ProjectionExpression: "notificationId",
                    ExclusiveStartKey: lastKey,
                }));
                for (const item of result.Items || []) {
                    const id = item.notificationId?.S;
                    if (id) idsToUpdate.push(id);
                }
                lastKey = result.LastEvaluatedKey;
            } while (lastKey);
        } else if (Array.isArray(target)) {
            idsToUpdate = target.filter((x): x is string => typeof x === "string" && !!x);
        } else {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "`ids` must be an array of strings or the literal \"all\".",
            });
        }

        const nowIso = new Date().toISOString();
        const updates = idsToUpdate.map(async (notificationId) => {
            // attribute_not_exists(readAt) is the idempotency guard — if the
            // row was already marked read, leave the original readAt intact.
            try {
                await ddb.send(new UpdateItemCommand({
                    TableName: NOTIFICATIONS_TABLE,
                    Key: {
                        userSub: { S: userSub },
                        notificationId: { S: notificationId },
                    },
                    UpdateExpression: "SET readAt = :now",
                    ConditionExpression: "attribute_not_exists(readAt)",
                    ExpressionAttributeValues: { ":now": { S: nowIso } },
                }));
            } catch (err: any) {
                if (err?.name !== "ConditionalCheckFailedException") throw err;
                // Already-read; that's fine.
            }
        });
        await Promise.all(updates);

        // Recompute unread count after the writes.
        const remaining = await ddb.send(new QueryCommand({
            TableName: NOTIFICATIONS_TABLE,
            KeyConditionExpression: "userSub = :u",
            ExpressionAttributeValues: { ":u": { S: userSub } },
            FilterExpression: "attribute_not_exists(readAt)",
            Select: "COUNT",
            Limit: 100,
        }));

        return json(event, 200, {
            unreadCount: remaining.Count || 0,
            updated: idsToUpdate.length,
        });
    } catch (err: any) {
        const message = err?.message || "Failed to mark notifications read";
        if (message.toLowerCase().includes("token")) {
            return json(event, 401, {
                error: "Unauthorized",
                statusCode: 401,
                message,
            });
        }
        console.error("[markNotificationsRead] error:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message,
        });
    }
};
