import {
    DynamoDBClient,
    ScanCommand,
    ScanCommandInput,
    QueryCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot, requireInternalGroup } from "./utils";
import { corsHeaders } from "./corsHeaders";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });
const CLINICS_TABLE = process.env.CLINICS_TABLE!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "";
const MESSAGES_TABLE = process.env.MESSAGES_TABLE || "";

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// Cheap per-clinic count helpers — best-effort, swallow errors. The restore
// modal uses these to show the user the blast radius of the action; if a count
// fails to load we fall back to null and the UI just hides that line.
const safeCount = async (clinicId: string): Promise<{ jobs: number | null; applications: number | null; messages: number | null }> => {
    const counts = { jobs: null as number | null, applications: null as number | null, messages: null as number | null };

    if (JOB_POSTINGS_TABLE) {
        try {
            const out = await dynamoClient.send(new QueryCommand({
                TableName: JOB_POSTINGS_TABLE,
                IndexName: "ClinicIdIndex",
                KeyConditionExpression: "clinicId = :cid",
                ExpressionAttributeValues: { ":cid": { S: clinicId } },
                Select: "COUNT",
            }));
            counts.jobs = out.Count ?? 0;
        } catch (err) {
            console.warn(`[listDeletedClinics] jobs count failed for ${clinicId}:`, (err as Error).message);
        }
    }

    // Applications and messages have no clinicId GSI; counting them per-clinic
    // would require a scan per row which is too expensive at list time. We skip
    // them here and let the modal display "—" for those rows. They still get
    // purged correctly by the cascade Lambda when TTL fires.

    return counts;
};

// GET /clinics/deleted — Root + Admin only. Returns clinics inside the 30-day
// restore window. Each row includes:
//   - daysRemaining     (urgency cue)
//   - relatedCounts     (cost-of-restore preview for the modal)
//   - deletedAt/deletedBy (so the modal can show who deleted, when)
// Rows where restoredAt is set (i.e. already restored) are excluded — they
// stay on the snapshot table as audit history but the list view only shows
// currently-deleted clinics.
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);

        const allowed = isRoot(userInfo.groups) || requireInternalGroup(userInfo.groups, ["Admin"]);
        if (!allowed) {
            return json(event, 403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root or Admin users can view deleted clinics.",
                timestamp: new Date().toISOString(),
            });
        }

        const items: Record<string, AttributeValue>[] = [];
        let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
        do {
            const input: ScanCommandInput = {
                TableName: CLINICS_TABLE,
                FilterExpression: "attribute_exists(deletedAt)",
                ExclusiveStartKey,
            };
            const resp = await dynamoClient.send(new ScanCommand(input));
            (resp.Items || []).forEach((it) => items.push(it));
            ExclusiveStartKey = resp.LastEvaluatedKey;
        } while (ExclusiveStartKey);

        const nowSec = Math.floor(Date.now() / 1000);

        // Fetch related counts in parallel — bounded by the number of deleted
        // clinics, which should be small in normal operation.
        const data = await Promise.all(items.map(async (it) => {
            const clinicId = it.clinicId?.S || "";
            const ttlSec = it.ttl?.N ? parseInt(it.ttl.N, 10) : null;
            const daysRemaining = ttlSec ? Math.max(0, Math.ceil((ttlSec - nowSec) / 86400)) : null;

            const relatedCounts = clinicId ? await safeCount(clinicId) : { jobs: null, applications: null, messages: null };

            return {
                clinicId,
                name: it.name?.S,
                city: it.city?.S,
                state: it.state?.S,
                deletedAt: it.deletedAt?.S,
                deletedBy: it.deletedBy?.S,
                purgeAt: ttlSec ? new Date(ttlSec * 1000).toISOString() : null,
                daysRemaining,
                relatedCounts,
            };
        }));

        return json(event, 200, {
            status: "success",
            statusCode: 200,
            data: { clinics: data, count: data.length },
            timestamp: new Date().toISOString(),
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error listing deleted clinics:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to list deleted clinics",
            details: { reason: err.message },
            timestamp: new Date().toISOString(),
        });
    }
};

exports.handler = handler;
