import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from "aws-lambda";
import {
    QueryCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { corsHeaders } from "./corsHeaders";
import { extractUserFromBearerToken, findSoftDeletedClinicIds } from "./utils";
import { ddb, NOTIFICATIONS_TABLE, itemToRecord } from "./notifications";

const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 500;

const json = (event: APIGatewayProxyEvent, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/**
 * GET /notifications?unreadOnly=true&limit=50&cursor=<base64>
 *
 * Returns the caller's notifications, newest first, plus an unread count.
 * Single Query against PK=userSub with ScanIndexForward=false; the sortable
 * notificationId (epoch-prefixed) gives reverse-chronological order without
 * a GSI.
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

        const qs = event.queryStringParameters || {};
        const unreadOnly = qs.unreadOnly === "true";
        const limit = Math.min(
            MAX_LIMIT,
            Math.max(1, parseInt(qs.limit || `${DEFAULT_LIMIT}`, 10) || DEFAULT_LIMIT)
        );

        let exclusiveStartKey: Record<string, AttributeValue> | undefined;
        if (qs.cursor) {
            try {
                exclusiveStartKey = JSON.parse(
                    Buffer.from(qs.cursor, "base64").toString("utf-8")
                );
            } catch {
                // Bad cursor — ignore and start from the top.
                exclusiveStartKey = undefined;
            }
        }

        const queryParams: ConstructorParameters<typeof QueryCommand>[0] = {
            TableName: NOTIFICATIONS_TABLE,
            KeyConditionExpression: "userSub = :u",
            ExpressionAttributeValues: { ":u": { S: userSub } },
            ScanIndexForward: false, // newest first (lexicographic descending on SK)
            Limit: limit,
            ExclusiveStartKey: exclusiveStartKey,
        };

        if (unreadOnly) {
            queryParams.FilterExpression = "attribute_not_exists(readAt)";
        }

        const result = await ddb.send(new QueryCommand(queryParams));

        let items = (result.Items || []).map(itemToRecord);

        // Drop notifications that point at soft-deleted (or purged) clinics —
        // a notification about a clinic that no longer exists is noise.
        const notifClinicIds = items
            .map(n => (n as any).clinicId as string | undefined)
            .filter((id): id is string => !!id);
        if (notifClinicIds.length > 0) {
            const deletedSet = await findSoftDeletedClinicIds(notifClinicIds);
            if (deletedSet.size > 0) {
                const before = items.length;
                items = items.filter((n) => {
                    const cid = (n as any).clinicId as string | undefined;
                    return !cid || !deletedSet.has(cid);
                });
                if (before !== items.length) {
                    console.log(`[listNotifications] Dropped ${before - items.length} notification(s) tied to soft-deleted clinics`);
                }
            }
        }

        // Best-effort unread count: query for unread items only, but cap the
        // count so a noisy user doesn't blow up Dynamo capacity. The frontend
        // renders the exact number up to 999, then "999+" beyond.
        const unreadResult = await ddb.send(new QueryCommand({
            TableName: NOTIFICATIONS_TABLE,
            KeyConditionExpression: "userSub = :u",
            ExpressionAttributeValues: { ":u": { S: userSub } },
            FilterExpression: "attribute_not_exists(readAt)",
            Select: "COUNT",
            Limit: 1000,
        }));
        const unreadCount = unreadResult.Count || 0;

        const nextCursor = result.LastEvaluatedKey
            ? Buffer.from(JSON.stringify(result.LastEvaluatedKey), "utf-8").toString("base64")
            : undefined;

        return json(event, 200, {
            items,
            unreadCount,
            nextCursor,
        });
    } catch (err: any) {
        const message = err?.message || "Failed to load notifications";
        if (message.toLowerCase().includes("token")) {
            return json(event, 401, {
                error: "Unauthorized",
                statusCode: 401,
                message,
            });
        }
        console.error("[listNotifications] error:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message,
        });
    }
};
