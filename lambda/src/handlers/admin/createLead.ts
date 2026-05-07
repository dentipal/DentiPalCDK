import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { randomUUID } from "crypto";
import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import {
    dynamo,
    LEADS_TABLE,
    LEAD_CREATE_ROLES,
    isLeadSource,
    isLeadStatus,
    writeActivity,
    resolveDisplayName,
    type LeadRecord,
    type LeadSource,
    type LeadStatus,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface CreateLeadBody {
    clinicName?: string;
    contactFirstName?: string;
    contactLastName?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    source?: LeadSource;
    status?: LeadStatus;
    notes?: string;
    tags?: string[];
}

/**
 * POST /admin/leads — Admin / Sales / Marketing.
 *
 * Creates a single lead and writes an `import` activity row attributing the
 * creator. Status defaults to "new"; source defaults to "manual".
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const caller = extractUserFromBearerToken(authHeader);
        if (!requireInternalGroup(caller.groups, LEAD_CREATE_ROLES)) {
            return json(event, 403, { error: "Forbidden", message: "Insufficient role." });
        }
        const performerName = await resolveDisplayName(caller.sub);

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: CreateLeadBody = JSON.parse(event.body);

        const clinicName = (body.clinicName || "").trim();
        const contactFirstName = (body.contactFirstName || "").trim();
        const contactLastName = (body.contactLastName || "").trim();
        const email = (body.email || "").toLowerCase().trim();
        const phone = (body.phone || "").trim();

        const missing = [
            !clinicName && "clinicName",
            !contactFirstName && "contactFirstName",
            !contactLastName && "contactLastName",
            !email && "email",
            !phone && "phone",
        ].filter(Boolean);
        if (missing.length > 0) {
            return json(event, 400, {
                error: "Bad Request",
                message: "Required fields are missing",
                details: { missingFields: missing },
            });
        }

        const status: LeadStatus = isLeadStatus(body.status) ? body.status : "new";
        const source: LeadSource = isLeadSource(body.source) ? body.source : "manual";
        const now = new Date().toISOString();
        const leadId = randomUUID();

        const lead: LeadRecord = {
            leadId,
            clinicName,
            contactFirstName,
            contactLastName,
            email,
            phone,
            city: body.city?.trim() || undefined,
            state: body.state?.trim() || undefined,
            source,
            status,
            notes: body.notes?.trim() || undefined,
            tags: Array.isArray(body.tags) && body.tags.length > 0 ? body.tags : undefined,
            createdBy: caller.sub,
            createdByName: performerName,
            createdAt: now,
            updatedAt: now,
            lastActivityAt: now,
        };

        await dynamo.send(new PutItemCommand({
            TableName: LEADS_TABLE,
            Item: marshall(lead, { removeUndefinedValues: true }),
            ConditionExpression: "attribute_not_exists(leadId)",
        }));

        await writeActivity({
            leadId,
            type: "import",
            performedBy: caller.sub,
            performedByName: performerName,
            content: `Lead created via ${source}`,
        });

        return json(event, 201, { status: "success", data: lead });
    } catch (error: any) {
        console.error("[createLead] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to create lead",
        });
    }
};
