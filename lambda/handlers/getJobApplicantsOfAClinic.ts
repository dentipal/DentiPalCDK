import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  BatchGetItemCommand,
  DescribeTableCommand,
  QueryCommandInput,
  ScanCommandInput,
  BatchGetItemCommandInput,
  DescribeTableCommandInput,
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
import { CORS_HEADERS } from "./corsHeaders";

async function getTableSchema(tableName: string) {
  try {
    const input: DescribeTableCommandInput = { TableName: tableName };
    const res = await dynamodb.send(new DescribeTableCommand(input));

    return {
      keySchema: res.Table?.KeySchema,
      attributeDefinitions: res.Table?.AttributeDefinitions,
      gsis: (res.Table?.GlobalSecondaryIndexes || []).map((g) => ({
        indexName: g.IndexName,
        keySchema: g.KeySchema,
        projection: g.Projection?.ProjectionType,
      })),
    };
  } catch (e: any) {
    console.error(`❌ describe ${tableName}:`, e.message);
    return null;
  }
}

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
  const jobs: any[] = [];

  for (const jobId of jobIds) {
    const attempts = [
      new QueryCommand({
        TableName: POSTINGS_TABLE,
        IndexName: "jobId-index",
        KeyConditionExpression: "jobId = :jid",
        ExpressionAttributeValues: { ":jid": { S: jobId } },
      }),
      new QueryCommand({
        TableName: POSTINGS_TABLE,
        KeyConditionExpression: "clinicId = :cid AND jobId = :jid",
        ExpressionAttributeValues: {
          ":cid": { S: clinicId },
          ":jid": { S: jobId },
        },
      }),
    ];

    let added = false;

    for (const cmd of attempts) {
      try {
        const r = await dynamodb.send(cmd);
        if (r.Items && r.Items.length) {
          jobs.push(unmarshall(r.Items[0] as Record<string, AttributeValue>));
          added = true;
          break;
        }
      } catch {}
    }
    if (!added) console.warn(`⚠️ job not found for jobId=${jobId}`);
  }

  return jobs;
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

async function fetchNegotiationsForNegotiatingApps(applications: any[], concurrency = 10) {
  const ids = dedupe(
    applications
      .filter((a) => (a.applicationStatus || "").toLowerCase() === "negotiating")
      .map((a) => (a.applicationId ?? "").toString().trim())
      .filter(Boolean)
  );

  console.log(
    `🤝 Negotiations fetch for ${ids.length} applicationIds on GSI "${NEGOTIATION_GSI}" (HASH=${NEGOTIATION_HASH_KEY})`
  );

  const out = new Map<string, any>();
  let cursor = 0;

  async function worker(wid: number) {
    while (true) {
      const idx = cursor++;
      if (idx >= ids.length) break;

      const applicationId = ids[idx];

      try {
        const resp = await dynamodb.send(
          new QueryCommand({
            TableName: NEGOTIATIONS_TABLE,
            IndexName: NEGOTIATION_GSI,
            KeyConditionExpression: "#pk = :pk",
            ExpressionAttributeNames: { "#pk": NEGOTIATION_HASH_KEY },
            ExpressionAttributeValues: { ":pk": { S: applicationId } },
          })
        );

        const items = (resp.Items || []).map((it) => unmarshall(it as Record<string, AttributeValue>));

        if (!items.length) {
          console.log(`🧭 [W${wid}] no negotiations for applicationId=${applicationId}`);
          out.set(applicationId, null);
          continue;
        }

        const latest = chooseLatestNegotiation(items);
        const clinicField = latest?.clinic ?? latest?.clinicId ?? null;

        out.set(applicationId, {
          negotiationId: latest?.negotiationId ?? null,
          clinicCounterHourlyRate: latest?.clinicCounterHourlyRate ?? null,
          professionalCounterHourlyRate: latest?.professionalCounterHourlyRate ?? null,
          clinic: clinicField,
          updatedAt: latest?.updatedAt ?? null,
          createdAt: latest?.createdAt ?? null,
        });

        console.log(
          `🧭 [W${wid}] applicationId=${applicationId} → negotiationId=${latest?.negotiationId ?? "N/A"}`
        );
      } catch (e: any) {
        console.error(`❌ [W${wid}] negotiations query failed for applicationId=${applicationId}:`, e.message);
        out.set(applicationId, null);
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, ids.length) }, (_, i) => worker(i + 1))
  );

  return out;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
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

    const postingsSchema = await getTableSchema(POSTINGS_TABLE);
    const profilesSchema = await getTableSchema(PROFILES_TABLE);
    const negotiationsSchema = await getTableSchema(NEGOTIATIONS_TABLE);

    console.log("📊 Postings schema:", postingsSchema);
    console.log("📊 Profiles schema:", profilesSchema);
    console.log("📊 Negotiations schema:", negotiationsSchema);

    const scanInput: ScanCommandInput = {
      TableName: APPLICATIONS_TABLE,
      FilterExpression: "#c = :clinicId",
      ExpressionAttributeNames: { "#c": "clinicId" },
      ExpressionAttributeValues: { ":clinicId": { S: clinicId } },
    };

    const scanResp = await dynamodb.send(new ScanCommand(scanInput));
    const applications = (scanResp.Items || []).map((it) => unmarshall(it as Record<string, AttributeValue>));

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

    const negotiationMap = await fetchNegotiationsForNegotiatingApps(applications);

    const keyVariations = [
      jobIds.map((jobId: string) => ({
        clinicId: { S: clinicId },
        jobId: { S: jobId },
      })),
      jobIds.map((jobId: string) => ({
        clinicUserSub: { S: clinicId },
        jobId: { S: jobId },
      })),
      jobIds.map((jobId: string) => ({ jobId: { S: jobId } })),
    ];

    const profileKeys = profSubs.map((s: string) => ({ userSub: { S: s } }));

    let postingsRaw: any[] = [];
    let profilesRaw: any[] = [];
    let success = false;

    for (let i = 0; i < keyVariations.length && !success; i++) {
      try {
        const batchResp = await batchGetAll({
          RequestItems: {
            [POSTINGS_TABLE]: { Keys: keyVariations[i] },
            [PROFILES_TABLE]: { Keys: profileKeys },
          },
        });

        postingsRaw = (batchResp.Responses?.[POSTINGS_TABLE] || []).map((item: Record<string, AttributeValue>) => unmarshall(item));
        profilesRaw = (batchResp.Responses?.[PROFILES_TABLE] || []).map((item: Record<string, AttributeValue>) => unmarshall(item));

        if (postingsRaw.length) success = true;
      } catch (e: any) {
        console.error(`❌ Batch variation ${i + 1} failed:`, e.message);
      }
    }

    if (!success) {
      postingsRaw = await getJobsUsingQuery(jobIds, clinicId);

      try {
        const pr = await batchGetAll({
          RequestItems: { [PROFILES_TABLE]: { Keys: profileKeys } },
        });

        profilesRaw = (pr.Responses?.[PROFILES_TABLE] || []).map((item: Record<string, AttributeValue>) => unmarshall(item));
      } catch (e: any) {
        console.error("❌ Profile batch fallback failed:", e.message);
      }
    }

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