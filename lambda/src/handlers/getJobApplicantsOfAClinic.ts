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
const PROFILES_TABLE = process.env.PROFILES_TABLE || "DentiPal-ProfessionalProfiles";
const NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

const NEGOTIATION_GSI = "applicationId-index";
const NEGOTIATION_HASH_KEY = "applicationId";

const dynamodb = new DynamoDBClient({ region: REGION });

// ✅ ADDED: Import auth utility
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

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

// BatchGetItem with automatic chunking for >100 keys
async function batchGetChunked(
  tables: Record<string, { Keys: Record<string, AttributeValue>[] }>,
  maxRetries = 3
) {
  // Collect all keys across tables, chunk to 100 total per request
  const allResponses: Record<string, any[]> = {};

  // Process each table separately to ensure no single request exceeds 100 keys
  for (const [tableName, tableRequest] of Object.entries(tables)) {
    allResponses[tableName] = [];
    const keyChunks = chunk(tableRequest.Keys, 100);

    for (const keyChunk of keyChunks) {
      const result = await batchGetAll({
        RequestItems: { [tableName]: { Keys: keyChunk } },
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
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

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
    setOriginFromEvent(event);
  // ✅ PREFLIGHT CHECK
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
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
      return json(400, {
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

    const queryInput: QueryCommandInput = jobIdFilter
      ? {
          TableName: APPLICATIONS_TABLE,
          IndexName: CLINIC_JOB_INDEX,
          KeyConditionExpression: "clinicId = :clinicId AND jobId = :jobId",
          ExpressionAttributeValues: {
            ":clinicId": { S: clinicId },
            ":jobId": { S: jobIdFilter },
          },
        }
      : {
          TableName: APPLICATIONS_TABLE,
          IndexName: CLINIC_ID_INDEX,
          KeyConditionExpression: "clinicId = :clinicId",
          ExpressionAttributeValues: { ":clinicId": { S: clinicId } },
        };

    console.log(`🔍 Query mode: ${jobIdFilter ? `filtered by jobId=${jobIdFilter}` : "all jobs"}`);

    const queryResp = await dynamodb.send(new QueryCommand(queryInput));
    const applications = (queryResp.Items || []).map((it) => unmarshall(it as Record<string, AttributeValue>));

    console.log(`📋 Found ${applications.length} applications`);

    if (!applications.length) {
      return json(200, {
        status: "success",
        statusCode: 200,
        message: "No job applications found",
        data: {
          clinicId: clinicId,
          totalApplications: 0,
          applications: [],
          byJobId: {}
        },
        timestamp: new Date().toISOString()
      });
    }

    const jobIds = dedupe(applications.map((a) => a.jobId).filter(Boolean));
    const profSubs = dedupe(applications.map((a) => a.professionalUserSub).filter(Boolean));

    // Fetch negotiations, job postings, and profiles in parallel
    const profileKeys = profSubs.map((s: string) => ({ userSub: { S: s } }));

    const [negotiationMap, postingsRaw, profilesRaw] = await Promise.all([
      // 1. Negotiations (batch + query hybrid)
      fetchNegotiationsForNegotiatingApps(applications),

      // 2. Job postings via jobId-index-1 GSI (reliable, no key guessing)
      getJobsUsingQuery(jobIds, clinicId),

      // 3. Professional profiles via BatchGetItem (userSub is the direct PK)
      profileKeys.length > 0
        ? batchGetChunked({ [PROFILES_TABLE]: { Keys: profileKeys } })
            .then((r) => (r.Responses?.[PROFILES_TABLE] || []).map((item: Record<string, AttributeValue>) => unmarshall(item)))
            .catch((e: any) => { console.error("❌ Profile batch failed:", e.message); return [] as any[]; })
        : Promise.resolve([] as any[]),
    ]);

    const postingByJobId = new Map(
      postingsRaw.filter(Boolean).map((p) => [p.jobId, p])
    );

    const profileByUserSub = new Map(
      profilesRaw.filter(Boolean).map((p) => [p.userSub, p])
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
        job: job ? { ...job, job_type: job.job_type || null } : null,
        professional: prof,
      };
    });

    const byJobId: Record<string, any> = {};

    for (const row of applicationsJoined) {
      const jid = row.application.jobId;

      if (!byJobId[jid]) byJobId[jid] = { job: row.job, applicants: [] };

      byJobId[jid].applicants.push({
        professional: row.professional,
        application: row.application,
        negotiation: row.negotiation,
      });
    }

    return json(200, {
      status: "success",
      statusCode: 200,
      message: "Job applicants retrieved successfully",
      data: {
        clinicId: clinicId,
        totalApplications: applicationsJoined.length,
        applications: applicationsJoined,
        byJobId: byJobId
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("❌ handler error:", error);
    
    // ✅ Added Auth error handling
    if (error.message === "Authorization header missing" || 
        error.message?.startsWith("Invalid authorization header") ||
        error.message === "Invalid access token format" ||
        error.message === "Failed to decode access token" ||
        error.message === "User sub not found in token claims") {
        
        return json(401, {
            error: "Unauthorized",
            details: error.message
        });
    }

    return json(500, {
      error: "Internal Server Error",
      statusCode: 500,
      message: "Failed to fetch applicants",
      details: { reason: error.message },
      timestamp: new Date().toISOString()
    });
  }
};