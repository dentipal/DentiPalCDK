"use strict";

const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Access-Control-Allow-Methods": "OPTIONS, GET",
};

/* ─────────────────────────────────────────────────────────────────────────────
   ADD #1: Normalize DynamoDB date attributes -> string[]
   Works with SS, L of {S:"..."}, single {S:"..."}, plain [] of strings,
   or object like {"0":"2025-08-29", ...}
───────────────────────────────────────────────────────────────────────────── */
function toStrArr(attr) {
  if (!attr) return [];
  if (Array.isArray(attr) && attr.every(v => typeof v === "string")) return attr;

  if (Array.isArray(attr.SS)) return attr.SS; // String Set
  if (Array.isArray(attr.L)) {
    return attr.L
      .map(v => (v && typeof v.S === "string" ? v.S : null))
      .filter(Boolean);
  }
  if (typeof attr.S === "string") return [attr.S];

  if (typeof attr === "object") {
    const vals = Object.values(attr);
    if (vals.every(v => typeof v === "string")) return vals;
  }
  return [];
}

/**
 * Extract clinicId from:
 * 1) query string (?clinicId=...)
 * 2) pathParameters.clinicId
 * 3) pathParameters.proxy split
 */
function extractClinicId(event) {
  const fromQuery = event.queryStringParameters?.clinicId;
  if (fromQuery && fromQuery.trim()) return fromQuery.trim();

  const fromPath = event.pathParameters?.clinicId;
  if (fromPath && fromPath.trim()) return fromPath.trim();

  const proxy = event.pathParameters?.proxy;
  if (proxy) {
    const parts = proxy.split("/").filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last !== "completed" && last !== "applications") return last.trim();
    if (parts[1]) return parts[1].trim();
  }
  return undefined;
}

/**
 * Map a raw DynamoDB item (AttributeValue map) to response shape.
 * ──> ADD #2: include dates[] + dateRange
 */
function mapPostingItem(item) {
  const start_date = item.start_date?.S;
  const start_time = item.start_time?.S;

  return {
    jobId: item.jobId?.S || "No jobId",
    jobTitle: item.professional_role?.S || "No title",
    jobType: item.job_type?.S || "Not specified",
    professionalRole: item.professional_role?.S || "Not specified",
    startTime:
      start_date && start_time
        ? `${start_date} ${start_time}`
        : (start_time || start_date || "Not specified"),
    endTime: item.end_time?.S || "Not specified",
    status: item.status?.S || "unknown",
    clinicId: item.clinicId?.S || "unknown",
    date: item.date?.S || null, // Single day date field
    start_date: item.start_date?.S || null, // Start date for permanent/multi-day
    hourlyRate: item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : null,
    salaryMin: item.salary_min?.N ? parseFloat(item.salary_min.N) : null,
    salaryMax: item.salary_max?.N ? parseFloat(item.salary_max.N) : null,


    // NEW:
    dates: toStrArr(item.dates),                                // ["YYYY-MM-DD", ...]
    dateRange: item.date_range?.S || item.dateRange?.S || null, // optional pretty range
  };
}

exports.handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: JSON.stringify({ message: "OK" }) };
    }

    // Auth
    await validateToken(event);

    const clinicId = extractClinicId(event);
    if (!clinicId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "clinicId is required (query param ?clinicId=...)" }),
      };
    }

    // SCAN with filter on clinicId + inactive status (consider a GSI for scale)
    const jobs = [];
    let lastEvaluatedKey = undefined;

    do {
      const scanCmd = new ScanCommand({
        TableName: "DentiPal-JobPostings",
        FilterExpression: "clinicId = :clinicId AND #st = :inactive",
        ExpressionAttributeValues: {
          ":clinicId": { S: clinicId },
          ":inactive": { S: "inactive" },
        },
        ExpressionAttributeNames: {
          "#st": "status",
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const scanRes = await dynamodb.send(scanCmd);
      if (scanRes.Items?.length) {
        for (const it of scanRes.Items) jobs.push(mapPostingItem(it));
      }
      lastEvaluatedKey = scanRes.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Optional: sort by the actual first date if available, else by startTime string
    jobs.sort((a, b) => {
      const aKey = Array.isArray(a.dates) && a.dates[0] ? a.dates[0] : (a.startTime || "");
      const bKey = Array.isArray(b.dates) && b.dates[0] ? b.dates[0] : (b.startTime || "");
      return String(aKey).localeCompare(String(bKey));
    });

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Completed shifts retrieved successfully",
        clinicId,
        count: jobs.length,
        jobs,
      }),
    };
  } catch (err) {
    console.error("Error retrieving completed shifts:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to retrieve completed shifts. Please try again.",
        details: err?.message || String(err),
      }),
    };
  }
};
