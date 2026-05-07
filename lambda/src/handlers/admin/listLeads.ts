import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    QueryCommand,
    ScanCommand,
    type ScanCommandInput,
    type QueryCommandInput,
    type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    isInternalUser,
} from "../utils";
import {
    dynamo,
    LEADS_TABLE,
    isLeadStatus,
    type LeadRecord,
    type LeadStatus,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

const encodeCursor = (key: Record<string, AttributeValue> | undefined): string | null =>
    key ? Buffer.from(JSON.stringify(key)).toString("base64") : null;

const decodeCursor = (cursor: string | undefined): Record<string, AttributeValue> | undefined => {
    if (!cursor) return undefined;
    try {
        return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    } catch {
        return undefined;
    }
};

/**
 * GET /admin/leads — any internal role.
 *
 * Query params:
 *   - status:  filter by lead status (uses status-lastActivityAt-index)
 *   - search:  case-insensitive substring match on clinicName / email / contact
 *              (post-filter, since DynamoDB has no contains-OR for this many cols)
 *   - limit:   page size (default 50, max 200)
 *   - cursor:  base64 LastEvaluatedKey from previous response
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!isInternalUser(caller.groups)) {
            return json(event, 403, { error: "Forbidden", message: "Internal access required." });
        }

        const qs = event.queryStringParameters || {};
        const status = isLeadStatus(qs.status) ? (qs.status as LeadStatus) : null;
        const search = (qs.search || "").toLowerCase().trim();
        const limit = Math.max(1, Math.min(200, parseInt(qs.limit || "50", 10) || 50));
        const cursor = decodeCursor(qs.cursor);

        let items: LeadRecord[] = [];
        let nextKey: Record<string, AttributeValue> | undefined;

        if (status) {
            const params: QueryCommandInput = {
                TableName: LEADS_TABLE,
                IndexName: "status-lastActivityAt-index",
                KeyConditionExpression: "#s = :s",
                ExpressionAttributeNames: { "#s": "status" },
                ExpressionAttributeValues: { ":s": { S: status } },
                ScanIndexForward: false, // newest activity first
                Limit: limit,
                ExclusiveStartKey: cursor,
            };
            const resp = await dynamo.send(new QueryCommand(params));
            items = (resp.Items || []).map((it) => unmarshall(it) as LeadRecord);
            nextKey = resp.LastEvaluatedKey;
        } else {
            // No status filter — paginated Scan. The dataset is expected to be small
            // (low thousands at most) for v1; if it grows, swap to a status-fanout
            // (issue 6 parallel queries, one per status, and merge by lastActivityAt).
            const params: ScanCommandInput = {
                TableName: LEADS_TABLE,
                Limit: limit,
                ExclusiveStartKey: cursor,
            };
            const resp = await dynamo.send(new ScanCommand(params));
            items = (resp.Items || []).map((it) => unmarshall(it) as LeadRecord);
            // Sort the page by lastActivityAt DESC client-side. Cross-page ordering
            // is not guaranteed without a status filter — the UI should make that clear.
            items.sort((a, b) => (b.lastActivityAt || "").localeCompare(a.lastActivityAt || ""));
            nextKey = resp.LastEvaluatedKey;
        }

        if (search) {
            items = items.filter((lead) => {
                const haystack = [
                    lead.clinicName,
                    lead.email,
                    lead.contactFirstName,
                    lead.contactLastName,
                    lead.phone,
                    lead.city,
                    lead.state,
                ]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                return haystack.includes(search);
            });
        }

        return json(event, 200, {
            status: "success",
            data: {
                leads: items,
                nextCursor: encodeCursor(nextKey),
                count: items.length,
            },
        });
    } catch (error: any) {
        console.error("[listLeads] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to list leads",
        });
    }
};
