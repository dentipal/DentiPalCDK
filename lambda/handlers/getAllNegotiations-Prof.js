// handlers/getAllNegotiations-Prof.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
  QueryCommand
} = require("@aws-sdk/client-dynamodb");

const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ✅ CORS helper that ECHOS the requesting origin (works with credentials)
const getCorsHeaders = (event) => {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  return {
    "Access-Control-Allow-Origin": origin || "",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Requested-With",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
};

// ---------- Small utils ----------
const str = (v) => (typeof v === "string" ? v.trim() : "");
const TABLE_NEGS   = process.env.JOB_NEGOTIATIONS_TABLE;
const TABLE_CLINICS = "DentiPal-ClinicProfiles";
const TABLE_JOBS   = process.env.JOB_POSTINGS_TABLE; // has jobId-index GSI in your jobs table

// ---------- Fetch helpers tailored to your indexes ----------

/** Get latest negotiation for an application (table PK = applicationId, SK = negotiationId or similar) */
async function fetchByApplicationId(applicationId) {
  try {
    const q = await dynamodb.send(new QueryCommand({
      TableName: TABLE_NEGS,
      KeyConditionExpression: "applicationId = :a",
      ExpressionAttributeValues: { ":a": { S: applicationId } },
      ScanIndexForward: false, // newest first
      Limit: 1,
    }));
    return q.Items?.[0] || null;
  } catch (e) {
    // Fallback scan if table key differs
    const s = await dynamodb.send(new ScanCommand({
      TableName: TABLE_NEGS,
      FilterExpression: "#app = :a",
      ExpressionAttributeNames: { "#app": "applicationId" },
      ExpressionAttributeValues: { ":a": { S: applicationId } },
      Limit: 1,
    }));
    return s.Items?.[0] || null;
  }
}

/**
 * Use your GSI **JobIndex** (PK: jobId, SK: createdAt) to fetch the latest
 * negotiation for a given jobId and professional. We query the index (newest first)
 * and pick the first item whose professionalUserSub matches.
 */
async function fetchByJobAndPro(jobId, professionalUserSub) {
  // Query JobIndex by jobId, newest first; then filter in memory by professionalUserSub
  const q = await dynamodb.send(new QueryCommand({
    TableName: TABLE_NEGS,
    IndexName: "JobIndex", // <-- from your screenshot
    KeyConditionExpression: "jobId = :jid",
    ExpressionAttributeValues: { ":jid": { S: jobId } },
    ScanIndexForward: false, // newest first (createdAt is SK)
    Limit: 50, // pull a few to find the first matching pro
  }));

  const items = q.Items || [];
  const match = items.find(it => (it.professionalUserSub?.S || "") === professionalUserSub);
  if (match) return match;

  // If nothing matched in the first page, you could paginate; for now, return null.
  return null;
}

/** List all negotiations for the authenticated professional (kept as Scan for now) */
async function fetchAllForProfessional(professionalUserSub, statusFilter) {
  const scanCommand = new ScanCommand({
    TableName: TABLE_NEGS,
    FilterExpression:
      "professionalUserSub = :sub" +
      (statusFilter ? " AND negotiationStatus = :status" : ""),
    ExpressionAttributeValues: {
      ":sub": { S: professionalUserSub },
      ...(statusFilter && { ":status": { S: statusFilter } }),
    },
  });
  const res = await dynamodb.send(scanCommand);
  return res.Items || [];
}

// ---------- Enrichment ----------
async function enrichWithClinicAndJob(neg) {
  const negotiation = {
    negotiationId: neg.negotiationId?.S || "",
    applicationId: neg.applicationId?.S || "",
    jobId: neg.jobId?.S || "",
    clinicId: neg.clinicId?.S || "",
    professionalUserSub: neg.professionalUserSub?.S || "",
    negotiationStatus: neg.negotiationStatus?.S || "",
    clinicResponse: neg.clinicResponse?.S || "",
    proposedHourlyRate: neg.proposedHourlyRate?.N ? parseFloat(neg.proposedHourlyRate.N) : null,
    message: neg.message?.S || "",
    createdAt: neg.createdAt?.S || "",
    updatedAt: neg.updatedAt?.S || "",
  };

  // Clinic info
  try {
    if (negotiation.clinicId) {
      const clinicResp = await dynamodb.send(new GetItemCommand({
        TableName: TABLE_CLINICS,
        Key: { clinicId: { S: negotiation.clinicId } },
      }));
      const c = clinicResp.Item;
      if (c) {
        negotiation.clinicInfo = {
          name: c.clinic_name?.S || "Unknown Clinic",
          city: c.city?.S || "",
          state: c.state?.S || "",
          primaryPracticeArea: c.primary_practice_area?.S || "",
          contactName: `${c.primary_contact_first_name?.S || ""} ${c.primary_contact_last_name?.S || ""}`.trim(),
        };
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch clinic info for ${negotiation.clinicId}:`, err);
  }

  // Job info (via jobs GSI jobId-index)
  try {
    if (negotiation.jobId) {
      const jobResult = await dynamodb.send(new QueryCommand({
        TableName: TABLE_JOBS,
        IndexName: "jobId-index",
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: { ":jobId": { S: negotiation.jobId } },
        Limit: 1,
      }));
      const job = jobResult.Items?.[0];
      if (job) {
        negotiation.jobInfo = {
          jobTitle: job.job_title?.S || `${job.professional_role?.S || "Professional"} Position`,
          jobType: job.job_type?.S || "",
          professionalRole: job.professional_role?.S || "",
          hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : null,
          hoursPerDay: job.hours_per_day?.N ? parseFloat(job.hours_per_day.N) : null,
          location: {
            city: job.city?.S || "",
            state: job.state?.S || "",
            zipCode: job.pincode?.S || "",
          },
          date: job.date?.S || "",
          startTime: job.start_time?.S || "",
          endTime: job.end_time?.S || "",
          status: job.status?.S || "active",
        };
      }
    }
  } catch (err) {
    console.warn(`Failed to fetch job info for ${negotiation.jobId}:`, err);
  }

  return negotiation;
}

// ---------- Handler ----------
const handler = async (event) => {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: getCorsHeaders(event), body: "" };
    }

    const qs = event.queryStringParameters || {};
    const statusFilter = str(qs.status) || null;

    // New filters supported for clinic/any side:
    const applicationId = str(qs.applicationId);
    const jobId = str(qs.jobId);
    const professionalUserSubParam = str(qs.professionalUserSub);

    // Try to identify caller (professional) for default listing; allow anonymous for the filtered lookups
    let professionalUserSub = null;
    try {
      professionalUserSub = await validateToken(event);
    } catch (_) {
      professionalUserSub = null;
    }

    // ---- Mode A: by applicationId (single, latest) ----
    if (applicationId) {
      const raw = await fetchByApplicationId(applicationId);
      if (!raw) {
        return {
          statusCode: 404,
          headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
          body: JSON.stringify({ error: "No negotiations found for this applicationId" }),
        };
      }
      const item = await enrichWithClinicAndJob(raw);
      return {
        statusCode: 200,
        headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
        body: JSON.stringify({ item }),
      };
    }

    // ---- Mode B: by jobId + professionalUserSub (single, latest) ----
    if (jobId && professionalUserSubParam) {
      const raw = await fetchByJobAndPro(jobId, professionalUserSubParam);
      if (!raw) {
        return {
          statusCode: 404,
          headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
          body: JSON.stringify({
            error: "No negotiation found for the given jobId and professionalUserSub",
          }),
        };
      }
      const item = await enrichWithClinicAndJob(raw);
      return {
        statusCode: 200,
        headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
        body: JSON.stringify({ item }),
      };
    }

    // ---- Mode C: default list for authenticated professional ----
    if (!professionalUserSub) {
      return {
        statusCode: 400,
        headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
        body: JSON.stringify({ error: "Missing authenticated user" }),
      };
    }

    const rawItems = await fetchAllForProfessional(professionalUserSub, statusFilter);
    const negotiations = [];
    for (const it of rawItems) {
      negotiations.push(await enrichWithClinicAndJob(it));
    }

    // sort by updatedAt desc
    negotiations.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    return {
      statusCode: 200,
      headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({
        message: "Negotiations retrieved successfully",
        negotiations,
        totalCount: negotiations.length,
        filter: statusFilter || "all",
      }),
    };
  } catch (error) {
    console.error("Error fetching negotiations:", error);
    return {
      statusCode: 500,
      headers: { ...getCorsHeaders(event), "Content-Type": "application/json" },
      body: JSON.stringify({
        error: "Failed to retrieve negotiations",
        details: error.message,
      }),
    };
  }
};

exports.handler = handler;