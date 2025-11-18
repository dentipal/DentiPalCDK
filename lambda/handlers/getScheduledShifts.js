"use strict";
const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, GET, POST, PUT, DELETE",
};

/* ─────────────────────────────────────────────────────────────────────────────
   ADD #1: Helper to normalize DynamoDB date attributes to string[]
   Works for: [ {S:"..."}, ... ], SS, L, single S, or already-plain arrays
───────────────────────────────────────────────────────────────────────────── */
function toStrArr(attr) {
  if (!attr) return [];
  // Already plain array of strings?
  if (Array.isArray(attr) && typeof attr[0] === "string") return attr;

  // DynamoDB AttributeValue shapes:
  if (Array.isArray(attr.SS)) return attr.SS; // String Set
  if (Array.isArray(attr.L)) {
    return attr.L
      .map((v) => (v && typeof v.S === "string" ? v.S : null))
      .filter(Boolean);
  }
  if (typeof attr.S === "string") return [attr.S];

  // Sometimes dates might come as an object like { "0": "2025-08-29", ... }
  if (typeof attr === "object") {
    const vals = Object.values(attr);
    if (vals.every((v) => typeof v === "string")) return vals;
  }
  return [];
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper: fetch job details from JobPostings via GSI (jobId-index)
// ─────────────────────────────────────────────────────────────────────────────
const makeJobDetailsFetcher = () => {
  const cache = new Map();
  return async function getJobDetailsByJobId(jobId) {
    if (!jobId) return {};
    if (cache.has(jobId)) return cache.get(jobId) || {};

    const cmd = new QueryCommand({
      TableName: "DentiPal-JobPostings",
      IndexName: "jobId-index",
      KeyConditionExpression: "jobId = :jobId",
      ExpressionAttributeValues: {
        ":jobId": { S: jobId },
      },
      Limit: 1,
      // Optional but recommended: ensure the GSI projects needed attrs:
      // ProjectionExpression: "#jt, #ttl, #prole, start_date, start_time, end_time, dates, date_range, clinicId",
      // ExpressionAttributeNames: { "#jt": "job_type", "#ttl": "job_title", "#prole": "professional_role" },
    });

    try {
      const res = await dynamodb.send(cmd);
      const item = res.Items && res.Items[0];
      if (!item) {
        console.error(`Job not found in JobPostings for jobId: ${jobId}`);
        cache.set(jobId, null);
        return {};
      }

      /* ─────────────────────────────────────────────────────────────────────
         ADD #2: pull dates & date_range from JobPostings using helper
         - dates can be SS or L of {S:"..."}
         - date_range may be stored as "date_range" (snake) or "dateRange"
      ───────────────────────────────────────────────────────────────────── */
      const details = {
        jobType: item.job_type?.S || "Not specified",
        jobTitle: item.professional_role?.S || "No title",
        professionalRole: item.professional_role?.S || "Not specified",
        startTime:
          (item.start_date?.S && item.start_time?.S)
            ? `${item.start_date.S} ${item.start_time.S}`
            : (item.start_time?.S || item.start_date?.S || "Not specified"),
        endTime: item.end_time?.S || "Not specified",
        start_date: item.start_date?.S,
        date:item.date?.S,
        start_time: item.start_time?.S,
        clinicId: item.clinicId?.S,
        hourlyRate: item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : null,
        salaryMin: item.salary_min?.N ? parseFloat(item.salary_min.N) : null,
        salaryMax: item.salary_max?.N ? parseFloat(item.salary_max.N) : null,
        // NEW:
        dates: toStrArr(item.dates),                 // ← array of "YYYY-MM-DD"
        dateRange: item.date_range?.S || item.dateRange?.S || null, // optional
      };

      cache.set(jobId, details);
      return details;
    } catch (err) {
      console.error(`Error querying JobPostings by jobId ${jobId}:`, err);
      cache.set(jobId, null);
      return {};
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────
const handler = async (event) => {
  try {
    // ✅ Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ message: "CORS preflight OK" }),
      };
    }

    const userSub = await validateToken(event);

    const pathParts = event.pathParameters?.proxy?.split("/");
    const clinicId = pathParts?.[1];

    if (!clinicId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "clinicId is required in path parameters" }),
        headers: CORS_HEADERS,
      };
    }

    const appsCmd = new QueryCommand({
      TableName: "DentiPal-JobApplications",
      IndexName: "clinicId-jobId-index",
      KeyConditionExpression: "clinicId = :clinicId",
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId },
      },
    });

    const appsRes = await dynamodb.send(appsCmd);

    if (!appsRes.Items || appsRes.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "No jobs found for this clinic" }),
        headers: CORS_HEADERS,
      };
    }

    const scheduledApps = appsRes.Items.filter(
      (it) => (it.applicationStatus?.S || "").toLowerCase() === "scheduled"
    );

    const getJobDetailsByJobId = makeJobDetailsFetcher();
    const distinctJobIds = Array.from(
      new Set(scheduledApps.map((it) => it.jobId?.S).filter(Boolean))
    );

    const detailsArray = await Promise.all(
      distinctJobIds.map((jid) => getJobDetailsByJobId(jid))
    );

    const detailsMap = new Map();
    distinctJobIds.forEach((jid, idx) => detailsMap.set(jid, detailsArray[idx] || {}));

    const scheduledJobs = scheduledApps.map((app) => {
      const jid = app.jobId?.S || "";
      const d = detailsMap.get(jid) || {};
      return {
        jobId: jid || "No jobId",
        jobTitle: d.jobTitle || "No title",
        jobType: d.jobType || "Not specified",
        dates: d.dates || [], 
                   // ← now populated
        date:d.date|| null,
        start_date:d.start_date|| null,
        hourlyRate: d.hourlyRate || null,
        salaryMin: d.salaryMin || null,   
        salaryMax: d.salaryMax || null,   
        dateRange: d.dateRange || null, 
        professionalRole: d.professionalRole || "Not specified",
        startTime: d.startTime || "Not specified",
        endTime: d.endTime || "Not specified",
        status: app.applicationStatus?.S || "Not specified",
        clinicId: clinicId,
      };
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Scheduled jobs retrieved successfully",
        jobs: scheduledJobs,
      }),
      headers: CORS_HEADERS,
    };
  } catch (error) {
    console.error("Error retrieving scheduled jobs:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to retrieve scheduled jobs. Please try again.",
        details: error.message,
      }),
      headers: CORS_HEADERS,
    };
  }
};

exports.handler = handler;
