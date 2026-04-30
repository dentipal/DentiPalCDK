import {
  DynamoDBClient,
  QueryCommand,
  BatchGetItemCommand,
  QueryCommandInput,
  BatchGetItemCommandInput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// ---------- env / config ----------
const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
const POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
// The CDK stack sets PROFESSIONAL_PROFILES_TABLE; keep PROFILES_TABLE as a legacy alias in case
// an older deployment env still uses the short name. Default matches the currently-provisioned
// V5 table so a missing env var doesn't silently hit a non-existent (and un-IAM-granted) table.
const PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || process.env.PROFILES_TABLE || "DentiPal-V5-ProfessionalProfiles";
const NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

const NEGOTIATION_GSI = "applicationId-index";
const NEGOTIATION_HASH_KEY = "applicationId";

// Pagination bounds for the applications query.
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

const dynamodb = new DynamoDBClient({ region: REGION });

// Encode/decode a DynamoDB ExclusiveStartKey as an opaque base64url nextToken
// so clients don't have to know the underlying key shape.
function encodeNextToken(key: Record<string, AttributeValue> | undefined): string | null {
  if (!key) return null;
  return Buffer.from(JSON.stringify(key)).toString("base64url");
}
function decodeNextToken(token?: string | null): Record<string, AttributeValue> | undefined {
  if (!token) return undefined;
  try {
    return JSON.parse(Buffer.from(token, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

// ✅ ADDED: Import auth utility
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

async function batchGetAll(request: BatchGetItemCommandInput, maxRetries = 3) {
  let result: any = { Responses: {}, UnprocessedKeys: {} };
  let toGet: BatchGetItemCommandInput = JSON.parse(JSON.stringify(request));

  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await dynamodb.send(new BatchGetItemCommand(toGet));

      for (const [tbl, items] of Object.entries(resp.Responses || {})) {
        result.Responses[tbl] = (result.Responses[tbl] || []).concat(items);
      }

      if (!resp.UnprocessedKeys || Object.keys(resp.UnprocessedKeys).length === 0) break;

      toGet = { RequestItems: resp.UnprocessedKeys };
      await new Promise((r) => setTimeout(r, 150 * (i + 1)));
    } catch (err) {
      if (i === maxRetries) throw err;
    }
  }
  return result;
}

// Chunk an array into groups of maxSize (DynamoDB BatchGetItem limit is 100)
function chunk<T>(arr: T[], maxSize: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += maxSize) {
    chunks.push(arr.slice(i, i + maxSize));
  }
  return chunks;
}

// BatchGetItem with automatic chunking for >100 keys.
// Accepts optional ProjectionExpression/ExpressionAttributeNames so callers can trim payload size.
async function batchGetChunked(
  tables: Record<string, {
    Keys: Record<string, AttributeValue>[];
    ProjectionExpression?: string;
    ExpressionAttributeNames?: Record<string, string>;
  }>,
  maxRetries = 3
) {
  const allResponses: Record<string, any[]> = {};

  for (const [tableName, tableRequest] of Object.entries(tables)) {
    allResponses[tableName] = [];
    const keyChunks = chunk(tableRequest.Keys, 100);

    for (const keyChunk of keyChunks) {
      const tableEntry: {
        Keys: Record<string, AttributeValue>[];
        ProjectionExpression?: string;
        ExpressionAttributeNames?: Record<string, string>;
      } = { Keys: keyChunk };
      if (tableRequest.ProjectionExpression) tableEntry.ProjectionExpression = tableRequest.ProjectionExpression;
      if (tableRequest.ExpressionAttributeNames) tableEntry.ExpressionAttributeNames = tableRequest.ExpressionAttributeNames;

      const result = await batchGetAll({
        RequestItems: { [tableName]: tableEntry },
      }, maxRetries);
      allResponses[tableName].push(...(result.Responses?.[tableName] || []));
    }
  }

  return { Responses: allResponses };
}

const dedupe = (arr: any[]) => {
  const s = new Set();
  const out: any[] = [];
  for (const v of arr) if (!s.has(v)) { s.add(v); out.push(v); }
  return out;
};

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

// Classifies errors thrown by extractUserFromBearerToken so handlers can return a generic 401.
function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return (
    msg === "Authorization header missing" ||
    msg.startsWith("Invalid authorization header") ||
    msg === "Invalid access token format" ||
    msg === "Failed to decode access token" ||
    msg === "User sub not found in token claims"
  );
}

async function getJobsUsingQuery(jobIds: string[], clinicId: string) {
  // Run all job queries in parallel instead of sequentially
  const results = await Promise.all(
    jobIds.map(async (jobId) => {
      // Try GSI first, then primary key
      try {
        const r = await dynamodb.send(
          new QueryCommand({
            TableName: POSTINGS_TABLE,
            IndexName: "jobId-index-1",
            KeyConditionExpression: "jobId = :jid",
            ExpressionAttributeValues: { ":jid": { S: jobId } },
          })
        );
        if (r.Items && r.Items.length) {
          return unmarshall(r.Items[0] as Record<string, AttributeValue>);
        }
      } catch {}

      // Fallback to primary key query
      try {
        const r = await dynamodb.send(
          new QueryCommand({
            TableName: POSTINGS_TABLE,
            KeyConditionExpression: "clinicId = :cid AND jobId = :jid",
            ExpressionAttributeValues: {
              ":cid": { S: clinicId },
              ":jid": { S: jobId },
            },
          })
        );
        if (r.Items && r.Items.length) {
          return unmarshall(r.Items[0] as Record<string, AttributeValue>);
        }
      } catch {}

      console.warn(`⚠️ job not found for jobId=${jobId}`);
      return null;
    })
  );

  return results.filter(Boolean);
}

function chooseLatestNegotiation(items: any[]) {
  if (!items?.length) return null;

  const ts = (o: any) => {
    const c = o?.updatedAt ?? o?.createdAt;
    if (c == null) return -Infinity;

    const n = Number(c);
    if (!Number.isNaN(n) && n > 0 && `${n}`.length >= 10) return n;

    const d = Date.parse(c);
    return Number.isNaN(d) ? -Infinity : d;
  };

  let best = items[0];
  let bestScore = ts(items[0]);

  for (let i = 1; i < items.length; i++) {
    const sc = ts(items[i]);
    if (sc > bestScore) {
      best = items[i];
      bestScore = sc;
    }
  }
  return best;
}

function formatNegotiation(item: any) {
  const clinicField = item?.clinic ?? item?.clinicId ?? null;
  return {
    negotiationId: item?.negotiationId ?? null,
    clinicCounterHourlyRate: item?.clinicCounterHourlyRate ?? null,
    professionalCounterHourlyRate: item?.professionalCounterHourlyRate ?? null,
    clinicCounterRate: item?.clinicCounterRate ?? item?.clinicCounterHourlyRate ?? null,
    professionalCounterRate: item?.professionalCounterRate ?? item?.professionalCounterHourlyRate ?? null,
    status: item?.status ?? item?.negotiationStatus ?? null,
    clinic: clinicField,
    updatedAt: item?.updatedAt ?? null,
    createdAt: item?.createdAt ?? null,
  };
}

async function fetchNegotiationsForNegotiatingApps(applications: any[]) {
  const negotiatingApps = applications.filter(
    (a) => (a.applicationStatus || "").toLowerCase() === "negotiating"
  );

  if (!negotiatingApps.length) {
    console.log("🤝 No negotiating applications — skipping negotiations fetch");
    return new Map<string, any>();
  }

  // Split: apps WITH a negotiationId can use BatchGetItem (1 call); others need a Query
  const withNegId: { applicationId: string; negotiationId: string }[] = [];
  const withoutNegId: string[] = [];

  for (const app of negotiatingApps) {
    const appId = (app.applicationId ?? "").toString().trim();
    const negId = (app.negotiationId ?? "").toString().trim();
    if (!appId) continue;
    if (negId) {
      withNegId.push({ applicationId: appId, negotiationId: negId });
    } else {
      withoutNegId.push(appId);
    }
  }

  console.log(`🤝 Negotiations: ${withNegId.length} via BatchGetItem, ${withoutNegId.length} via Query`);

  const out = new Map<string, any>();

  // --- Path A: BatchGetItem for apps with known negotiationId (1 call for up to 100) ---
  if (withNegId.length > 0) {
    const uniqueKeys = dedupe(withNegId.map((k) => `${k.applicationId}|${k.negotiationId}`))
      .map((key: string) => {
        const [appId, negId] = key.split("|");
        return { applicationId: { S: appId }, negotiationId: { S: negId } };
      });

    try {
      const batchResult = await batchGetChunked({
        [NEGOTIATIONS_TABLE]: { Keys: uniqueKeys },
      });

      for (const raw of batchResult.Responses?.[NEGOTIATIONS_TABLE] || []) {
        const item = unmarshall(raw as Record<string, AttributeValue>);
        const appId = (item.applicationId ?? "").toString().trim();
        if (appId) {
          out.set(appId, formatNegotiation(item));
          console.log(`🧭 [batch] applicationId=${appId} → negotiationId=${item.negotiationId ?? "N/A"}`);
        }
      }
    } catch (e: any) {
      console.error("❌ BatchGetItem for negotiations failed, falling back to Query:", e.message);
      // Move failed keys to the query path
      withoutNegId.push(...withNegId.map((k) => k.applicationId));
    }
  }

  // --- Path B: Query primary table for apps without negotiationId ---
  const toQuery = dedupe(withoutNegId.filter((id) => !out.has(id)));

  if (toQuery.length > 0) {
    await Promise.all(
      toQuery.map(async (applicationId: string) => {
        try {
          const resp = await dynamodb.send(
            new QueryCommand({
              TableName: NEGOTIATIONS_TABLE,
              KeyConditionExpression: "applicationId = :pk",
              ExpressionAttributeValues: { ":pk": { S: applicationId } },
            })
          );

          const items = (resp.Items || []).map((it) => unmarshall(it as Record<string, AttributeValue>));

          if (!items.length) {
            out.set(applicationId, null);
            return;
          }

          const latest = chooseLatestNegotiation(items);
          out.set(applicationId, formatNegotiation(latest));
          console.log(`🧭 [query] applicationId=${applicationId} → negotiationId=${latest?.negotiationId ?? "N/A"}`);
        } catch (e: any) {
          console.error(`❌ Negotiation query failed for applicationId=${applicationId}:`, e.message);
          out.set(applicationId, null);
        }
      })
    );
  }

  return out;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // ✅ PREFLIGHT CHECK
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    console.log("📝 Event:", JSON.stringify(event, null, 2));

    // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
    // Validate that a user is logged in before fetching sensitive applicant data
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    extractUserFromBearerToken(authHeader);
    // ------------------------------------------------

    const path = event.path || "";
    const clinicId = path.split("/")[1];

    console.log(`🏥 Clinic ID: ${clinicId}`);

    if (!clinicId) {
      return json(event, 400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Clinic ID is required",
        details: { pathFormat: "/{clinicId}/applicants" },
        timestamp: new Date().toISOString()
      });
    }

    const CLINIC_ID_INDEX = process.env.CLINIC_ID_INDEX || "clinicId-index";
    const CLINIC_JOB_INDEX = process.env.CLINIC_JOB_INDEX || "clinicId-jobId-index";

    // Optional jobId filter — when provided, use the composite GSI for a targeted query
    const jobIdFilter = event.queryStringParameters?.jobId;

    // Pagination — clients pass `limit` (capped) and `nextToken` (opaque from a previous response).
    const requestedLimit = Number(event.queryStringParameters?.limit);
    const pageLimit = Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), MAX_PAGE_LIMIT)
      : DEFAULT_PAGE_LIMIT;
    const exclusiveStartKey = decodeNextToken(event.queryStringParameters?.nextToken);

    // Filter out already-acted-on applications at the DDB layer so pagination pages don't look sparse
    // to the client. DDB's LastEvaluatedKey is computed against scanned items (pre-filter), so cursor
    // pagination remains correct whether a batch filters 0 items or all of them.
    const nonActionableFilter = "(attribute_not_exists(applicationStatus) OR NOT (applicationStatus IN (:sAccepted, :sRejected, :sScheduled, :sCompleted, :sHired, :sDeclined, :sConfirmed)))";
    const nonActionableValues: Record<string, AttributeValue> = {
      ":sAccepted": { S: "accepted" },
      ":sRejected": { S: "rejected" },
      ":sScheduled": { S: "scheduled" },
      ":sCompleted": { S: "completed" },
      ":sHired": { S: "hired" },
      ":sDeclined": { S: "declined" },
      ":sConfirmed": { S: "confirmed" },
    };

    const queryInput: QueryCommandInput = jobIdFilter
      ? {
          TableName: APPLICATIONS_TABLE,
          IndexName: CLINIC_JOB_INDEX,
          KeyConditionExpression: "clinicId = :clinicId AND jobId = :jobId",
          FilterExpression: nonActionableFilter,
          ExpressionAttributeValues: {
            ":clinicId": { S: clinicId },
            ":jobId": { S: jobIdFilter },
            ...nonActionableValues,
          },
          Limit: pageLimit,
          ExclusiveStartKey: exclusiveStartKey,
        }
      : {
          TableName: APPLICATIONS_TABLE,
          IndexName: CLINIC_ID_INDEX,
          KeyConditionExpression: "clinicId = :clinicId",
          FilterExpression: nonActionableFilter,
          ExpressionAttributeValues: {
            ":clinicId": { S: clinicId },
            ...nonActionableValues,
          },
          Limit: pageLimit,
          ExclusiveStartKey: exclusiveStartKey,
        };

    console.log(`🔍 Query mode: ${jobIdFilter ? `filtered by jobId=${jobIdFilter}` : "all jobs"} (limit=${pageLimit}${exclusiveStartKey ? ", paginated" : ""})`);

    const queryResp = await dynamodb.send(new QueryCommand(queryInput));
    const applications = (queryResp.Items || []).map((it) => unmarshall(it as Record<string, AttributeValue>));
    const nextToken = encodeNextToken(queryResp.LastEvaluatedKey as Record<string, AttributeValue> | undefined);

    console.log(`📋 Found ${applications.length} applications${nextToken ? " (more available)" : ""}`);

    if (!applications.length) {
      return json(event, 200, {
        status: "success",
        statusCode: 200,
        message: "No job applications found",
        data: {
          clinicId: clinicId,
          totalApplications: 0,
          applications: [],
          byJobId: {},
          pagination: { limit: pageLimit, nextToken: null },
        },
        timestamp: new Date().toISOString()
      });
    }

    const jobIds = dedupe(applications.map((a) => a.jobId).filter(Boolean));
    const profSubs = dedupe(applications.map((a) => a.professionalUserSub).filter(Boolean));

    // Fetch negotiations, job postings, and profiles in parallel
    const profileKeys = profSubs.map((s: string) => ({ userSub: { S: s } }));

    // Project only the fields the applicants list needs. The profile modal re-fetches the full
    // profile on open, so bio/certificates/skills/specializations/videos don't need to ride along
    // with every applicant card — that was inflating response size ~10x for no visible gain.
    const PROFILE_LIST_PROJECTION =
      "userSub, firstName, first_name, lastName, last_name, professional_role, professionalRole, #role, yearsExperience, years_of_experience, yearsOfExperience, profile_image_url, profileImageKey";
    const PROFILE_LIST_EXPR_NAMES = { "#role": "role" };

    const [negotiationMap, postingsRaw, profilesRaw] = await Promise.all([
      // 1. Negotiations (batch + query hybrid)
      fetchNegotiationsForNegotiatingApps(applications),

      // 2. Job postings via jobId-index-1 GSI (reliable, no key guessing)
      getJobsUsingQuery(jobIds, clinicId),

      // 3. Professional profiles via BatchGetItem — trimmed projection.
      profileKeys.length > 0
        ? batchGetChunked({
            [PROFILES_TABLE]: {
              Keys: profileKeys,
              ProjectionExpression: PROFILE_LIST_PROJECTION,
              ExpressionAttributeNames: PROFILE_LIST_EXPR_NAMES,
            },
          })
            .then((r) => (r.Responses?.[PROFILES_TABLE] || []).map((item: Record<string, AttributeValue>) => unmarshall(item)))
            .catch((e: any) => { console.error("❌ Profile batch failed:", e.message); return [] as any[]; })
        : Promise.resolve([] as any[]),
    ]);

    const postingByJobId = new Map(
      postingsRaw.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => [p.jobId, p])
    );

    const profileByUserSub = new Map(
      profilesRaw.filter((p): p is NonNullable<typeof p> => Boolean(p)).map((p) => [p.userSub, p])
    );

    const applicationsJoined = applications.map((app) => {
      const job = postingByJobId.get(app.jobId) || null;
      const prof = profileByUserSub.get(app.professionalUserSub) || null;

      const isNegotiating = (app.applicationStatus || "").toLowerCase() === "negotiating";

      const appIdTrimmed = (app.applicationId ?? "").toString().trim();

      const nego = isNegotiating
        ? negotiationMap.get(appIdTrimmed) || null
        : null;

      return {
        application: {
          applicationId: app.applicationId,
          jobId: app.jobId,
          clinicId: app.clinicId,
          professionalUserSub: app.professionalUserSub,
          applicationStatus: app.applicationStatus,
          appliedAt: app.appliedAt,
          updatedAt: app.updatedAt,
          proposedRate: app.proposedRate ?? null,
          negotiationId: app.negotiationId ?? null,
        },
        negotiation: nego,
        // `job` lives on byJobId[jobId].job so it's not duplicated per applicant in the flat list.
        _job: job,  // internal — stripped below before returning
        professional: prof,
      };
    });

    const byJobId: Record<string, any> = {};

    for (const row of applicationsJoined) {
      const jid = row.application.jobId;
      const job = row._job;

      if (!byJobId[jid]) byJobId[jid] = { job: job ? { ...job, job_type: job.job_type || null } : null, applicants: [] };

      byJobId[jid].applicants.push({
        professional: row.professional,
        application: row.application,
        negotiation: row.negotiation,
      });
    }

    // Strip the private `_job` reference so clients see only { application, negotiation, professional }.
    const applicationsFlat = applicationsJoined.map(({ _job, ...rest }) => rest);

    return json(event, 200, {
      status: "success",
      statusCode: 200,
      message: "Job applicants retrieved successfully",
      data: {
        clinicId: clinicId,
        totalApplications: applicationsFlat.length,
        applications: applicationsFlat,
        byJobId: byJobId,
        pagination: { limit: pageLimit, nextToken: nextToken },
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("❌ handler error:", error);

    if (isAuthError(error)) {
      // Return a generic 401 — server logs above retain the specific reason.
      return json(event, 401, {
        status: "error",
        statusCode: 401,
        error: "Unauthorized",
        message: "Authentication required",
        timestamp: new Date().toISOString(),
      });
    }

    return json(event, 500, {
      status: "error",
      statusCode: 500,
      error: "Internal Server Error",
      message: "Failed to fetch applicants",
      timestamp: new Date().toISOString(),
    });
  }
};