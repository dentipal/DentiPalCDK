import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { randomUUID } from "crypto";
import { BatchWriteItemCommand } from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import {
    dynamo,
    LEADS_TABLE,
    LEAD_ACTIVITY_TABLE,
    LEAD_BULK_UPLOAD_ROLES,
    isLeadSource,
    newActivityId,
    resolveDisplayName,
    type LeadRecord,
    type LeadSource,
} from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface CsvRow {
    clinicName?: string;
    contactFirstName?: string;
    contactLastName?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    source?: LeadSource;
    notes?: string;
    tags?: string[];
}

interface BulkBody {
    rows?: CsvRow[];
}

interface RowFailure {
    index: number;
    reason: string;
    row: CsvRow;
}

const validateRow = (row: CsvRow): string | null => {
    // Every CSV column is optional. The only failure modes are:
    //   1. Row is entirely empty (we skip it rather than insert blank leads).
    //   2. Email is provided but malformed (don't store junk).
    //   3. Source is provided but not in the allowed enum.
    const trimOrEmpty = (v?: string) => (v ?? "").toString().trim();
    const fields = [
        row.clinicName,
        row.contactFirstName,
        row.contactLastName,
        row.email,
        row.phone,
        row.city,
        row.state,
        row.notes,
        row.source,
    ];
    if (fields.every((f) => trimOrEmpty(f as string | undefined) === "")) {
        return "row is empty";
    }
    const email = trimOrEmpty(row.email);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        return "email is malformed";
    }
    const source = trimOrEmpty(row.source);
    if (source && !isLeadSource(source)) {
        return "invalid source";
    }
    return null;
};

/**
 * POST /admin/leads/bulk — Admin / Marketing.
 *
 * Accepts pre-parsed CSV rows from the frontend and inserts valid ones via
 * BatchWriteItem chunks of 25 (DynamoDB's hard cap). Each insert also writes
 * an `import` activity row attributing the upload to the caller. Invalid rows
 * are skipped and returned in the `failed[]` field so the UI can surface them.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const caller = extractUserFromBearerToken(authHeader);
        if (!requireInternalGroup(caller.groups, LEAD_BULK_UPLOAD_ROLES)) {
            return json(event, 403, { error: "Forbidden", message: "Admin or Marketing role required." });
        }

        if (!event.body) {
            return json(event, 400, { error: "Bad Request", message: "Request body is required" });
        }
        const body: BulkBody = JSON.parse(event.body);
        const rows = Array.isArray(body.rows) ? body.rows : null;
        if (!rows) {
            return json(event, 400, { error: "Bad Request", message: "rows[] is required" });
        }
        if (rows.length === 0) {
            return json(event, 400, { error: "Bad Request", message: "rows[] must not be empty" });
        }
        if (rows.length > 5000) {
            // Soft cap to keep Lambda well under its 60s timeout. Larger imports
            // should be split into multiple POSTs by the client.
            return json(event, 400, {
                error: "Bad Request",
                message: "Maximum 5000 rows per upload. Please split your file.",
            });
        }

        const performerName = await resolveDisplayName(caller.sub);
        const now = new Date().toISOString();

        const validLeads: LeadRecord[] = [];
        const failed: RowFailure[] = [];

        rows.forEach((row, index) => {
            const reason = validateRow(row);
            if (reason) {
                failed.push({ index, reason, row });
                return;
            }
            const leadId = randomUUID();
            const source: LeadSource = isLeadSource(row.source) ? row.source : "csv_upload";
            // All fields optional — store only what's present, skip empty ones via
            // marshall's removeUndefinedValues so DDB doesn't carry empty strings.
            validLeads.push({
                leadId,
                clinicName: row.clinicName?.trim() || undefined,
                contactFirstName: row.contactFirstName?.trim() || undefined,
                contactLastName: row.contactLastName?.trim() || undefined,
                email: row.email?.toLowerCase().trim() || undefined,
                phone: row.phone?.trim() || undefined,
                city: row.city?.trim() || undefined,
                state: row.state?.trim() || undefined,
                source,
                status: "new",
                notes: row.notes?.trim() || undefined,
                tags: Array.isArray(row.tags) && row.tags.length > 0 ? row.tags : undefined,
                createdBy: caller.sub,
                createdByName: performerName,
                createdAt: now,
                updatedAt: now,
                lastActivityAt: now,
            });
        });

        // Each lead also generates an `import` activity row, so we batch
        // (lead + activity) pairs together. BatchWriteItem caps at 25 items per
        // request total, so we chunk every 12 pairs (12*2 = 24 items, headroom = 1).
        const PAIRS_PER_BATCH = 12;
        let inserted = 0;
        for (let i = 0; i < validLeads.length; i += PAIRS_PER_BATCH) {
            const slice = validLeads.slice(i, i + PAIRS_PER_BATCH);
            const requestItems: Record<string, any[]> = {
                [LEADS_TABLE]: slice.map((lead) => ({
                    PutRequest: {
                        Item: marshall(lead, { removeUndefinedValues: true }),
                    },
                })),
                [LEAD_ACTIVITY_TABLE]: slice.map((lead) => ({
                    PutRequest: {
                        Item: marshall(
                            {
                                leadId: lead.leadId,
                                activityId: newActivityId(now),
                                type: "import",
                                performedBy: caller.sub,
                                performedByName: performerName,
                                createdAt: now,
                                content: `Bulk-imported via ${lead.source}`,
                            },
                            { removeUndefinedValues: true }
                        ),
                    },
                })),
            };

            // Retry unprocessed items per the DynamoDB BatchWriteItem contract
            // (capacity throttling can return them; we re-submit until empty).
            let pending: Record<string, any[]> | undefined = requestItems;
            let retryAttempt = 0;
            while (pending && Object.keys(pending).length > 0) {
                const resp: any = await dynamo.send(new BatchWriteItemCommand({
                    RequestItems: pending as any,
                }));
                pending = resp.UnprocessedItems && Object.keys(resp.UnprocessedItems).length > 0
                    ? resp.UnprocessedItems
                    : undefined;
                if (pending) {
                    retryAttempt++;
                    if (retryAttempt > 5) {
                        throw new Error("BatchWriteItem retry budget exceeded");
                    }
                    // Linear backoff is fine here — Lambda has plenty of timeout headroom.
                    await new Promise((res) => setTimeout(res, 200 * retryAttempt));
                }
            }
            inserted += slice.length;
        }

        return json(event, 200, {
            status: "success",
            data: {
                inserted,
                failed,
                totalSubmitted: rows.length,
            },
        });
    } catch (error: any) {
        console.error("[bulkUploadLeads] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to bulk upload leads",
        });
    }
};
