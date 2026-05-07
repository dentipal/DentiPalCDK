import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall, unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import {
    dynamo,
    LEADS_TABLE,
    LEAD_WRITE_ROLES,
    getLeadIdFromEvent,
    isLeadStatus,
    writeActivity,
    resolveDisplayName,
    type LeadRecord,
    type LeadStatus,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface StatusBody {
    status?: LeadStatus;
    note?: string;
}

/**
 * PATCH /admin/leads/{leadId}/status — Admin / Sales.
 *
 * Captures previous→new transition in the activity log so the timeline shows
 * pipeline progression.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const caller = extractUserFromBearerToken(authHeader);
        if (!requireInternalGroup(caller.groups, LEAD_WRITE_ROLES)) {
            return json(event, 403, { error: "Forbidden", message: "Insufficient role." });
        }

        const leadId = getLeadIdFromEvent(event);
        if (!leadId) {
            return json(event, 400, { error: "Bad Request", message: "leadId path parameter is required" });
        }
        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: StatusBody = JSON.parse(event.body);
        if (!isLeadStatus(body.status)) {
            return json(event, 400, { error: "Bad Request", message: "Invalid status" });
        }

        // Read current status so the activity row can record the transition.
        const cur = await dynamo.send(new GetItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            ProjectionExpression: "#s",
            ExpressionAttributeNames: { "#s": "status" },
        }));
        if (!cur.Item) {
            return json(event, 404, { error: "Not Found", message: "No lead with that id" });
        }
        const previousStatus = cur.Item.status?.S;
        if (previousStatus === body.status) {
            // No-op — return early without polluting the activity log.
            const fresh = await dynamo.send(new GetItemCommand({
                TableName: LEADS_TABLE,
                Key: marshall({ leadId }),
            }));
            return json(event, 200, {
                status: "success",
                data: fresh.Item ? (unmarshall(fresh.Item) as LeadRecord) : null,
            });
        }

        const now = new Date().toISOString();
        const upd = await dynamo.send(new UpdateItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            UpdateExpression: "SET #s = :ns, updatedAt = :now, lastActivityAt = :now",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: marshall({ ":ns": body.status, ":now": now }),
            ReturnValues: "ALL_NEW",
        }));

        const performerName = await resolveDisplayName(caller.sub);
        await writeActivity({
            leadId,
            type: "status_change",
            performedBy: caller.sub,
            performedByName: performerName,
            content: body.note?.trim() || undefined,
            previousValue: previousStatus,
            newValue: body.status,
        });

        return json(event, 200, {
            status: "success",
            data: upd.Attributes ? (unmarshall(upd.Attributes) as LeadRecord) : null,
        });
    } catch (error: any) {
        console.error("[updateLeadStatus] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to update lead status",
        });
    }
};
