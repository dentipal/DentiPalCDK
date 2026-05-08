import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandInput,
    BatchGetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "./corsHeaders";
import { extractUserFromBearerToken, isInternalUser } from "./utils";

const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const dynamo = new DynamoDBClient({ region: REGION });

const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE!;
const CLINICS_TABLE = process.env.CLINICS_TABLE!;

const NO_SHOW_REVIEW_INDEX = "noShowReview-index";
const JOB_ID_INDEX = "jobId-index-1";

const VALID_STATUSES = new Set(["pending_review", "reviewed", "actioned"]);

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
 * GET /admin/no-show-reports?status=pending_review&limit=50&cursor=...
 * Internal-only. Lists JobApplications rows where applicationStatus = 'no_show',
 * filtered by noShowReviewStatus. Hydrates each row with a minimal shift / professional /
 * clinic snapshot so the admin UI can render without follow-up calls.
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
        const status = qs.status && VALID_STATUSES.has(qs.status) ? qs.status : "pending_review";
        const limit = Math.max(1, Math.min(200, parseInt(qs.limit || "50", 10) || 50));
        const cursor = decodeCursor(qs.cursor);

        const queryParams: QueryCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            IndexName: NO_SHOW_REVIEW_INDEX,
            KeyConditionExpression: "noShowReviewStatus = :s",
            ExpressionAttributeValues: { ":s": { S: status } },
            ScanIndexForward: false,
            Limit: limit,
            ExclusiveStartKey: cursor,
        };

        const resp = await dynamo.send(new QueryCommand(queryParams));
        const rawRows = (resp.Items || []).map((it) => unmarshall(it));

        // --- Hydrate (minimal: gather unique IDs, batch-get in parallel) ---
        const jobIds = Array.from(new Set(rawRows.map((r) => r.jobId).filter(Boolean)));
        const profSubs = Array.from(new Set(rawRows.map((r) => r.professionalUserSub).filter(Boolean)));
        const clinicIds = Array.from(new Set(rawRows.map((r) => r.clinicId).filter(Boolean)));

        const [jobsByJobId, profsBySub, clinicsById] = await Promise.all([
            fetchJobsByJobId(jobIds),
            batchGet(PROFESSIONAL_PROFILES_TABLE, profSubs.map((s) => ({ userSub: { S: s as string } }))),
            batchGet(CLINICS_TABLE, clinicIds.map((c) => ({ clinicId: { S: c as string } }))),
        ]);

        const reports = rawRows.map((row) => {
            const job = jobsByJobId.get(row.jobId) || {};
            const prof = profsBySub.get(row.professionalUserSub) || {};
            const clinic = clinicsById.get(row.clinicId) || {};
            return {
                jobId: row.jobId,
                professionalUserSub: row.professionalUserSub,
                clinicId: row.clinicId,
                applicationStatus: row.applicationStatus,
                noShowReviewStatus: row.noShowReviewStatus,
                noShowReportedAt: row.noShowReportedAt,
                clinicNotes: row.clinicNotes || "",
                confirmedByUserSub: row.confirmedByUserSub,
                noShowReviewedByUserSub: row.noShowReviewedByUserSub,
                noShowReviewedAt: row.noShowReviewedAt,
                noShowResolutionNotes: row.noShowResolutionNotes || "",
                shift: {
                    role: job.professional_role || "",
                    date: job.date || job.start_date || "",
                    startTime: job.start_time || "",
                    endTime: job.end_time || "",
                    rate: job.rate ? Number(job.rate) : 0,
                    location: job.fullAddress || job.city || "",
                    jobType: job.job_type || "",
                },
                professional: {
                    name: prof.fullName || [prof.firstName, prof.lastName].filter(Boolean).join(" ") || "",
                    email: prof.email || "",
                    phone: prof.phone || "",
                },
                clinic: {
                    name: clinic.clinicName || clinic.name || "",
                    city: clinic.city || "",
                    state: clinic.state || "",
                },
            };
        });

        return json(event, 200, {
            status: "success",
            data: {
                reports,
                nextCursor: encodeCursor(resp.LastEvaluatedKey),
                count: reports.length,
            },
        });
    } catch (error: any) {
        console.error("[listNoShowReports] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to list no-show reports",
        });
    }
};

async function fetchJobsByJobId(jobIds: string[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (jobIds.length === 0) return out;
    // JobPostings PK is clinicUserSub + jobId, so we Query the jobId GSI per id.
    await Promise.all(
        jobIds.map(async (jobId) => {
            try {
                const r = await dynamo.send(new QueryCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    IndexName: JOB_ID_INDEX,
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: jobId } },
                    Limit: 1,
                }));
                if (r.Items && r.Items[0]) out.set(jobId, unmarshall(r.Items[0]));
            } catch (e) {
                console.warn("[listNoShowReports] failed to fetch job", { jobId, error: (e as Error).message });
            }
        })
    );
    return out;
}

async function batchGet(table: string, keys: Record<string, AttributeValue>[]): Promise<Map<string, any>> {
    const out = new Map<string, any>();
    if (!table || keys.length === 0) return out;
    // BatchGet allows max 100 per call.
    const chunks: Record<string, AttributeValue>[][] = [];
    for (let i = 0; i < keys.length; i += 100) chunks.push(keys.slice(i, i + 100));

    for (const chunk of chunks) {
        try {
            const resp = await dynamo.send(new BatchGetItemCommand({
                RequestItems: { [table]: { Keys: chunk } },
            }));
            const items = resp.Responses?.[table] || [];
            for (const item of items) {
                const obj = unmarshall(item);
                const key = obj.userSub || obj.clinicId;
                if (key) out.set(key, obj);
            }
        } catch (e) {
            console.warn("[listNoShowReports] batchGet failed", { table, error: (e as Error).message });
        }
    }
    return out;
}
