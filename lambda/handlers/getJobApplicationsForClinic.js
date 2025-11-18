"use strict";

const {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  BatchGetItemCommand,
} = require("@aws-sdk/client-dynamodb");

// ---- env / config ----
const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";

// Applications table
const APPLICATIONS_TABLE =
  process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";

// Job postings table (PK: clinicUserSub, SK: jobId)
const POSTINGS_TABLE =
  process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// Professional profiles (PK: userSub)
const PROFESSIONAL_PROFILES_TABLE =
  process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-ProfessionalProfiles";

// Job negotiations table (PK: negotiationId)
const NEGOTIATIONS_TABLE =
  process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

const ddb = new DynamoDBClient({ region: REGION });

// ---- CORS ----
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
  "Content-Type": "application/json",
};

// ---------- helpers ----------
const JJ = (x) => {
  try { return JSON.stringify(x, null, 2); } catch { return String(x); }
};

function getClinicIdFromPath(event) {
  // Prefer pathParameters
  const pp = event?.pathParameters || {};
  if (pp.clinicId) return String(pp.clinicId);

  // Try proxy style
  if (pp.proxy) {
    const parts = String(pp.proxy).split("/").filter(Boolean);
    // expect .../{clinicId}/jobs
    const jobsIdx = parts.findIndex((p) => p.toLowerCase() === "jobs");
    if (jobsIdx > 0) return parts[jobsIdx - 1];
  }

  // Fallback to raw path
  const p = event?.path || event?.rawPath || "";
  const parts = p.split("/").filter(Boolean);
  const jobsIdx = parts.findIndex((seg) => seg.toLowerCase() === "jobs");
  if (jobsIdx > 0) return parts[jobsIdx - 1];

  return undefined;
}

/** Query postings table for all jobs of a clinic (PK = clinicUserSub). */
async function listClinicJobs(clinicId) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: POSTINGS_TABLE,
        KeyConditionExpression: "#pk = :c",
        ExpressionAttributeNames: { "#pk": "clinicUserSub" },
        ExpressionAttributeValues: { ":c": { S: String(clinicId) } },
        ExclusiveStartKey,
      })
    );
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/** Scan applications for this clinicId + jobId. */
async function listApplicationsForJob(clinicId, jobId) {
  const items = [];
  let ExclusiveStartKey;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: APPLICATIONS_TABLE,
        FilterExpression: "#clinic = :c AND #job = :j",
        ExpressionAttributeNames: { "#clinic": "clinicId", "#job": "jobId" },
        ExpressionAttributeValues: {
          ":c": { S: String(clinicId) },
          ":j": { S: String(jobId) },
        },
        ExclusiveStartKey,
      })
    );
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/** BatchGet professional profiles by userSub; returns Map<userSub, Item>. */
async function batchGetProfiles(userSubs) {
  const out = new Map();
  const CHUNK = 100;

  for (let i = 0; i < userSubs.length; i += CHUNK) {
    const keys = userSubs.slice(i, i + CHUNK).map((u) => ({ userSub: { S: String(u) } }));
    if (!keys.length) continue;

    const res = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [PROFESSIONAL_PROFILES_TABLE]: { Keys: keys },
        },
      })
    );

    const found = res?.Responses?.[PROFESSIONAL_PROFILES_TABLE] || [];
    for (const item of found) {
      const k = item?.userSub?.S;
      if (k) out.set(k, item);
    }

    // One simple retry for unprocessed keys
    const unprocessed = res?.UnprocessedKeys?.[PROFESSIONAL_PROFILES_TABLE];
    if (unprocessed?.Keys?.length) {
      const retry = await ddb.send(
        new BatchGetItemCommand({ RequestItems: { [PROFESSIONAL_PROFILES_TABLE]: unprocessed } })
      );
      const retryFound = retry?.Responses?.[PROFESSIONAL_PROFILES_TABLE] || [];
      for (const item of retryFound) {
        const k = item?.userSub?.S;
        if (k) out.set(k, item);
      }
    }
  }

  return out;
}

/** BatchGet negotiations by negotiationId; returns Map<negotiationId, Item>. */
async function batchGetNegotiations(negIds) {
  const out = new Map();
  const CHUNK = 100;

  for (let i = 0; i < negIds.length; i += CHUNK) {
    const keys = negIds.slice(i, i + CHUNK).map((id) => ({ negotiationId: { S: String(id) } }));
    if (!keys.length) continue;

    const res = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [NEGOTIATIONS_TABLE]: { Keys: keys },
        },
      })
    );

    const found = res?.Responses?.[NEGOTIATIONS_TABLE] || [];
    for (const item of found) {
      const k = item?.negotiationId?.S;
      if (k) out.set(k, item);
    }

    // One simple retry for unprocessed keys
    const unprocessed = res?.UnprocessedKeys?.[NEGOTIATIONS_TABLE];
    if (unprocessed?.Keys?.length) {
      const retry = await ddb.send(
        new BatchGetItemCommand({ RequestItems: { [NEGOTIATIONS_TABLE]: unprocessed } })
      );
      const retryFound = retry?.Responses?.[NEGOTIATIONS_TABLE] || [];
      for (const item of retryFound) {
        const k = item?.negotiationId?.S;
        if (k) out.set(k, item);
      }
    }
  }

  return out;
}

// ---------- handler ----------
exports.handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  console.log("============= 🟦 getJobApplicationsForClinic START");
  console.log("Raw event:", JJ(event));

  try {
    const clinicId = getClinicIdFromPath(event);
    if (!clinicId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "clinicId is required (path: /{clinicId}/jobs)" }),
      };
    }

    // 1) All jobs for the clinic
    const jobs = await listClinicJobs(clinicId);
    console.log(`Found ${jobs.length} job postings for clinic ${clinicId}`);

    // 2) Fetch applicants for each job (in parallel, but controlled)
    const jobRows = await Promise.all(
      jobs.map(async (job) => {
        const jobId = job?.jobId?.S;
        if (!jobId) return null;

        const applications = await listApplicationsForJob(clinicId, jobId);
        return {
          jobId,
          jobPosting: job,        // raw AV (as in your existing handlers)
          applicants: applications // raw AV
        };
      })
    );

    const grouped = jobRows.filter(Boolean);

    // 3) Collect all unique professional subs for one batch profile lookup
    const allSubs = Array.from(
      new Set(
        grouped.flatMap((jr) =>
          (jr.applicants || []).map(
            (a) => a?.professionalUserSub?.S || a?.applicantUserSub?.S || a?.userSub?.S || null
          ).filter(Boolean)
        )
      )
    );

    const profileMap = allSubs.length ? await batchGetProfiles(allSubs) : new Map();

    // 4) Collect all unique negotiationIds for one batch negotiation lookup
    const allNegIds = Array.from(
      new Set(
        grouped.flatMap((jr) =>
          (jr.applicants || []).map((a) => a?.negotiationId?.S || null).filter(Boolean)
        )
      )
    );

    const negMap = allNegIds.length ? await batchGetNegotiations(allNegIds) : new Map();

    // 5) Enrich each applicant with profile and negotiation (and pass through AV shape)
    for (const jr of grouped) {
      jr.applicants = (jr.applicants || []).map((a) => {
        const sub =
          a?.professionalUserSub?.S || a?.applicantUserSub?.S || a?.userSub?.S || undefined;
        const profileItem = sub ? profileMap.get(sub) : undefined;

        const negId = a?.negotiationId?.S;
        const negotiationItem = negId ? negMap.get(negId) : undefined;

        return {
          ...a,
          professionalProfile: profileItem,
          negotiation: negotiationItem,
        };
      });
    }

    console.log(`Returning ${grouped.length} job buckets with applicants`);
    console.log("============= 🟩 getJobApplicationsForClinic END");

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        clinicId,
        jobs: grouped, // [{ jobId, jobPosting, applicants: [...] }]
        totalApplicants: grouped.reduce((s, r) => s + (r.applicants?.length || 0), 0),
      }),
    };
  } catch (err) {
    console.error("❌ Handler error:", err);
    console.log("============= 🟥 getJobApplicationsForClinic END (ERROR)");
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to fetch clinic job applicants", details: err.message }),
    };
  }
};