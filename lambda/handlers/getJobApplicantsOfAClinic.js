"use strict";

const {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  BatchGetItemCommand,
  DescribeTableCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");

// ---------- env / config ----------
const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
const POSTINGS_TABLE     = process.env.JOB_POSTINGS_TABLE     || "DentiPal-JobPostings";
const PROFILES_TABLE     = process.env.PROFILES_TABLE         || "DentiPal-ProfessionalProfiles";
const NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

// GSI is exactly this; HASH key is applicationId (String)
const NEGOTIATION_GSI = "applicationId-index";
const NEGOTIATION_HASH_KEY = "applicationId";

const dynamodb = new DynamoDBClient({ region: REGION });

// ---------- helpers ----------
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

async function getTableSchema(tableName) {
  try {
    const res = await dynamodb.send(new DescribeTableCommand({ TableName: tableName }));
    return {
      keySchema: res.Table.KeySchema,
      attributeDefinitions: res.Table.AttributeDefinitions,
      gsis: (res.Table.GlobalSecondaryIndexes || []).map(g => ({
        indexName: g.IndexName,
        keySchema: g.KeySchema,
        projection: g.Projection?.ProjectionType,
      })),
    };
  } catch (e) {
    console.error(`❌ describe ${tableName}:`, e.message);
    return null;
  }
}

async function batchGetAll(request, maxRetries = 3) {
  let result = { Responses: {}, UnprocessedKeys: {} };
  let toGet = JSON.parse(JSON.stringify(request));
  for (let i = 0; i <= maxRetries; i++) {
    try {
      const resp = await dynamodb.send(new BatchGetItemCommand(toGet));
      for (const [tbl, items] of Object.entries(resp.Responses || {})) {
        result.Responses[tbl] = (result.Responses[tbl] || []).concat(items);
      }
      if (!resp.UnprocessedKeys || Object.keys(resp.UnprocessedKeys).length === 0) break;
      toGet = { RequestItems: resp.UnprocessedKeys };
      await new Promise(r => setTimeout(r, 150 * (i + 1)));
    } catch (err) {
      if (i === maxRetries) throw err;
    }
  }
  return result;
}

const dedupe = (arr) => {
  const s = new Set(); const out = [];
  for (const v of arr) if (!s.has(v)) { s.add(v); out.push(v); }
  return out;
};

async function getJobsUsingQuery(jobIds, clinicId) {
  const jobs = [];
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
        ExpressionAttributeValues: { ":cid": { S: clinicId }, ":jid": { S: jobId } },
      }),
    ];
    let added = false;
    for (const cmd of attempts) {
      try {
        const r = await dynamodb.send(cmd);
        if (r.Items && r.Items.length) {
          jobs.push(unmarshall(r.Items[0]));
          added = true;
          break;
        }
      } catch {}
    }
    if (!added) console.warn(`⚠️ job not found for jobId=${jobId}`);
  }
  return jobs;
}

/** choose the most recent negotiation by updatedAt/createdAt if present */
function chooseLatestNegotiation(items) {
  if (!items?.length) return null;
  const ts = (o) => {
    const c = o?.updatedAt ?? o?.createdAt;
    if (c == null) return -Infinity;
    const n = Number(c);
    if (!Number.isNaN(n) && n > 0 && `${n}`.length >= 10) return n; // epoch seconds/ms
    const d = Date.parse(c);
    return Number.isNaN(d) ? -Infinity : d;
  };
  let best = items[0], bestScore = ts(items[0]);
  for (let i = 1; i < items.length; i++) {
    const sc = ts(items[i]);
    if (sc > bestScore) { best = items[i]; bestScore = sc; }
  }
  return best;
}

/**
 * Fetch negotiations ONLY for applications whose status is "negotiating" (case-insensitive)
 * Uses GSI: applicationId-index (HASH: applicationId as String).
 * Returns Map<applicationId, { negotiationId, clinicCounterHourlyRate, professionalCounterHourlyRate, clinicId?, updatedAt?, createdAt? } | null>
 */
async function fetchNegotiationsForNegotiatingApps(applications, concurrency = 10) {
  const ids = dedupe(
    applications
      .filter(a => (a.applicationStatus || "").toLowerCase() === "negotiating")
      .map(a => (a.applicationId ?? "").toString().trim())
      .filter(Boolean)
  );
  console.log(`🤝 Negotiations fetch for ${ids.length} applicationIds on GSI "${NEGOTIATION_GSI}" (HASH=${NEGOTIATION_HASH_KEY})`);

  const out = new Map();
  let cursor = 0;

  async function worker(wid) {
    while (true) {
      const idx = cursor++;
      if (idx >= ids.length) break;
      const applicationId = ids[idx];

      try {
        const resp = await dynamodb.send(new QueryCommand({
          TableName:       NEGOTIATIONS_TABLE,
          IndexName:       NEGOTIATION_GSI,
          KeyConditionExpression: "#pk = :pk",
          ExpressionAttributeNames:  { "#pk": NEGOTIATION_HASH_KEY },
          ExpressionAttributeValues: { ":pk": { S: applicationId } },
          // No ProjectionExpression -> get all attrs that the index projects
          // If GSI is KEYS_ONLY/INCLUDE, ensure required fields are projected
        }));
        const items = (resp.Items || []).map(unmarshall);
        if (!items.length) {
          console.log(`🧭 [W${wid}] no negotiations for applicationId=${applicationId}`);
          out.set(applicationId, null);
          continue;
        }
        const latest = chooseLatestNegotiation(items);
        // Some tables use "clinic" vs "clinicId" — map whichever exists
        const clinicField = latest?.clinic ?? latest?.clinicId ?? null;

        out.set(applicationId, {
          negotiationId: latest?.negotiationId ?? null,
          clinicCounterHourlyRate: latest?.clinicCounterHourlyRate ?? null,
          professionalCounterHourlyRate: latest?.professionalCounterHourlyRate ?? null,
          clinic: clinicField,
          updatedAt: latest?.updatedAt ?? null,
          createdAt: latest?.createdAt ?? null,
        });
        console.log(`🧭 [W${wid}] applicationId=${applicationId} → negotiationId=${latest?.negotiationId ?? "N/A"}`);
      } catch (e) {
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

exports.handler = async (event) => {
  try {
    console.log("📝 Event:", JSON.stringify(event, null, 2));
    const path = event.path || "";
    const clinicId = path.split("/")[1];
    console.log(`🏥 Clinic ID: ${clinicId}`);

    if (!clinicId) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "clinicId is required in the path" }) };
    }

    // ── Schema logs (useful for verifying GSI presence/projection) ──
    const postingsSchema     = await getTableSchema(POSTINGS_TABLE);
    const profilesSchema     = await getTableSchema(PROFILES_TABLE);
    const negotiationsSchema = await getTableSchema(NEGOTIATIONS_TABLE);
    console.log("📊 Postings schema:", postingsSchema);
    console.log("📊 Profiles schema:", profilesSchema);
    console.log("📊 Negotiations schema:", negotiationsSchema);

    // 1) Applications for the clinic
    const scanResp = await dynamodb.send(new ScanCommand({
      TableName: APPLICATIONS_TABLE,
      FilterExpression: "#c = :clinicId",
      ExpressionAttributeNames: { "#c": "clinicId" },
      ExpressionAttributeValues: { ":clinicId": { S: clinicId } },
    }));
    const applications = (scanResp.Items || []).map(unmarshall);
    console.log(`📋 Found ${applications.length} applications`);
    if (!applications.length) {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ clinicId, totalApplications: 0, applications: [], byJobId: {} }) };
    }

    const jobIds   = dedupe(applications.map(a => a.jobId).filter(Boolean));
    const profSubs = dedupe(applications.map(a => a.professionalUserSub).filter(Boolean));

    // 2) Negotiations ONLY for negotiating apps (exact GSI/hash)
    const negotiationMap = await fetchNegotiationsForNegotiatingApps(applications, 10);

    // 3) Postings + profiles via BatchGet (with key variations) / fallbacks
    const keyVariations = [
      jobIds.map(jobId => ({ clinicId: { S: clinicId }, jobId: { S: jobId } })),
      jobIds.map(jobId => ({ clinicUserSub: { S: clinicId }, jobId: { S: jobId } })),
      jobIds.map(jobId => ({ jobId: { S: jobId } })),
    ];
    const profileKeys = profSubs.map(s => ({ userSub: { S: s } }));

    let postingsRaw = [];
    let profilesRaw = [];
    let success = false;

    for (let i = 0; i < keyVariations.length && !success; i++) {
      try {
        const batchResp = await batchGetAll({
          RequestItems: {
            [POSTINGS_TABLE]: { Keys: keyVariations[i] },
            [PROFILES_TABLE]: { Keys: profileKeys },
          },
        });
        postingsRaw = (batchResp.Responses?.[POSTINGS_TABLE] || []).map(unmarshall);
        profilesRaw = (batchResp.Responses?.[PROFILES_TABLE] || []).map(unmarshall);
        if (postingsRaw.length) success = true;
      } catch (e) {
        console.error(`❌ Batch variation ${i + 1} failed:`, e.message);
      }
    }

    if (!success) {
      postingsRaw = await getJobsUsingQuery(jobIds, clinicId);
      try {
        const pr = await batchGetAll({ RequestItems: { [PROFILES_TABLE]: { Keys: profileKeys } } });
        profilesRaw = (pr.Responses?.[PROFILES_TABLE] || []).map(unmarshall);
      } catch (e) {
        console.error("❌ Profile batch fallback failed:", e.message);
      }
    }

    const postingByJobId   = new Map(postingsRaw.filter(Boolean).map(p => [p.jobId, p]));
    const profileByUserSub = new Map(profilesRaw.filter(Boolean).map(p => [p.userSub, p]));

    // 4) Join & aggregate
    const applicationsJoined = applications.map(app => {
      const job  = postingByJobId.get(app.jobId) || null;
      const prof = profileByUserSub.get(app.professionalUserSub) || null;

      const isNegotiating = (app.applicationStatus || "").toLowerCase() === "negotiating";
      const nego = isNegotiating ? (negotiationMap.get((app.applicationId ?? "").toString().trim()) || null) : null;

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
        negotiation: nego, // { negotiationId, clinicCounterHourlyRate, professionalCounterHourlyRate, clinic?, updatedAt?, createdAt? } | null
        job: job ? { ...job, job_type: job.job_type || null } : null,
        professional: prof,
      };
    });

    const byJobId = {};
    for (const row of applicationsJoined) {
      const jid = row.application.jobId;
      if (!byJobId[jid]) byJobId[jid] = { job: row.job, applicants: [] };
      byJobId[jid].applicants.push({
        professional: row.professional,
        application: row.application,
        negotiation: row.negotiation,
      });
    }

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify(
        { clinicId, totalApplications: applicationsJoined.length, applications: applicationsJoined, byJobId },
        null,
        2
      ),
    };
  } catch (error) {
    console.error("❌ handler error:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to fetch applicants", details: error.message }),
    };
  }
};
