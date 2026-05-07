import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { GetItemCommand, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
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
    isCallDisposition,
    writeActivity,
    resolveDisplayName,
    type ActivityType,
    type CallDisposition,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface ActivityBody {
    type?: "note" | "call";
    content?: string;
    callDisposition?: CallDisposition;
}

/**
 * POST /admin/leads/{leadId}/activity — Admin / Sales.
 *
 * Adds a free-text note or call log to a lead's timeline. Only "note" and
 * "call" types are accepted via this endpoint; "status_change" / "import"
 * are emitted by the corresponding mutation handlers.
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
        const body: ActivityBody = JSON.parse(event.body);

        const type: ActivityType = body.type === "call" ? "call" : "note";
        const content = (body.content || "").trim();
        if (type === "note" && !content) {
            return json(event, 400, { error: "Bad Request", message: "Note content is required" });
        }
        if (type === "call" && !isCallDisposition(body.callDisposition)) {
            return json(event, 400, {
                error: "Bad Request",
                message: "callDisposition is required for call activity",
            });
        }

        // Sanity check: confirm the lead exists before writing.
        const lead = await dynamo.send(new GetItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            ProjectionExpression: "leadId",
        }));
        if (!lead.Item) {
            return json(event, 404, { error: "Not Found", message: "No lead with that id" });
        }

        const performerName = await resolveDisplayName(caller.sub);

        const written = await writeActivity({
            leadId,
            type,
            performedBy: caller.sub,
            performedByName: performerName,
            content: content || undefined,
            callDisposition: type === "call" ? body.callDisposition : undefined,
        });

        // Bump lastActivityAt on the parent lead so it surfaces near the top of
        // the pipeline view after a touch.
        await dynamo.send(new UpdateItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            UpdateExpression: "SET lastActivityAt = :now, updatedAt = :now",
            ExpressionAttributeValues: marshall({ ":now": written.createdAt }),
        }));

        return json(event, 201, {
            status: "success",
            data: {
                leadId,
                activityId: written.activityId,
                type,
                createdAt: written.createdAt,
                performedBy: caller.sub,
                performedByName: performerName,
                content: content || undefined,
                callDisposition: type === "call" ? body.callDisposition : undefined,
            },
        });
    } catch (error: any) {
        console.error("[addLeadActivity] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to add activity",
        });
    }
};
