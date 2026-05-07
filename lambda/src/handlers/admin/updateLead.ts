import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { UpdateItemCommand } from "@aws-sdk/client-dynamodb";
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
    isLeadSource,
    writeActivity,
    resolveDisplayName,
    type LeadRecord,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

// Whitelist of editable lead fields. Status changes go through the dedicated
// /status endpoint so the activity log captures previous→new transitions.
const EDITABLE_FIELDS = [
    "clinicName",
    "contactFirstName",
    "contactLastName",
    "email",
    "phone",
    "city",
    "state",
    "notes",
    "tags",
    "source",
] as const;
type EditableField = (typeof EDITABLE_FIELDS)[number];

/**
 * PATCH /admin/leads/{leadId} — Admin / Sales.
 *
 * Updates editable lead fields. Bumps updatedAt and lastActivityAt and writes
 * a `note` activity row noting the field-level diff.
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

        const body = JSON.parse(event.body) as Partial<Record<EditableField, unknown>>;

        const updates: Record<string, any> = {};
        const touchedFields: EditableField[] = [];

        for (const field of EDITABLE_FIELDS) {
            if (!(field in body)) continue;
            const value = body[field];
            if (field === "source") {
                if (!isLeadSource(value)) {
                    return json(event, 400, { error: "Bad Request", message: "Invalid source" });
                }
                updates.source = value;
            } else if (field === "tags") {
                if (value !== null && !Array.isArray(value)) {
                    return json(event, 400, { error: "Bad Request", message: "tags must be an array" });
                }
                updates.tags = value || undefined;
            } else if (field === "email") {
                updates.email = typeof value === "string" ? value.toLowerCase().trim() : undefined;
            } else {
                updates[field] = typeof value === "string" ? value.trim() || undefined : value;
            }
            touchedFields.push(field);
        }

        if (touchedFields.length === 0) {
            return json(event, 400, { error: "Bad Request", message: "No editable fields provided" });
        }

        const now = new Date().toISOString();
        updates.updatedAt = now;
        updates.lastActivityAt = now;

        // Build dynamic UpdateExpression. Use REMOVE for explicit-null/undefined
        // values so callers can clear an optional field.
        const setExpr: string[] = [];
        const removeExpr: string[] = [];
        const names: Record<string, string> = {};
        const values: Record<string, any> = {};
        let i = 0;
        for (const [field, value] of Object.entries(updates)) {
            const nameKey = `#f${i}`;
            names[nameKey] = field;
            if (value === undefined || value === null || value === "") {
                removeExpr.push(nameKey);
            } else {
                const valueKey = `:v${i}`;
                values[valueKey] = value;
                setExpr.push(`${nameKey} = ${valueKey}`);
            }
            i++;
        }
        const updateExpr = [
            setExpr.length ? `SET ${setExpr.join(", ")}` : "",
            removeExpr.length ? `REMOVE ${removeExpr.join(", ")}` : "",
        ].filter(Boolean).join(" ");

        const resp = await dynamo.send(new UpdateItemCommand({
            TableName: LEADS_TABLE,
            Key: marshall({ leadId }),
            UpdateExpression: updateExpr,
            ConditionExpression: "attribute_exists(leadId)",
            ExpressionAttributeNames: names,
            ExpressionAttributeValues: Object.keys(values).length > 0
                ? marshall(values, { removeUndefinedValues: true })
                : undefined,
            ReturnValues: "ALL_NEW",
        }));

        const updated = resp.Attributes ? (unmarshall(resp.Attributes) as LeadRecord) : null;

        const performerName = await resolveDisplayName(caller.sub);
        await writeActivity({
            leadId,
            type: "note",
            performedBy: caller.sub,
            performedByName: performerName,
            content: `Updated fields: ${touchedFields.join(", ")}`,
        });

        return json(event, 200, { status: "success", data: updated });
    } catch (error: any) {
        console.error("[updateLead] error:", error);
        if (error.name === "ConditionalCheckFailedException") {
            return json(event, 404, { error: "Not Found", message: "No lead with that id" });
        }
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to update lead",
        });
    }
};
