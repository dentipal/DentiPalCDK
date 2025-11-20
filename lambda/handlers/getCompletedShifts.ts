"use strict";

import {
  DynamoDBClient,
  ScanCommand,
  ScanCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

// IMPORTANT: Lambda runs JS → keep `.js`
import { validateToken } from "./utils.js";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// DynamoDB Client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

/* ─────────────────────────────────────────────────────────────────────────────
   ADD #1: Normalize DynamoDB date attributes -> string[]
───────────────────────────────────────────────────────────────────────────── */
function toStrArr(attr: any): string[] {
  if (!attr) return [];

  if (Array.isArray(attr) && attr.every(v => typeof v === "string"))
    return attr;

  if (Array.isArray(attr?.SS)) return attr.SS;

  if (Array.isArray(attr?.L)) {
    return attr.L
      .map((v: AttributeValue) =>
        v && typeof (v as any).S === "string" ? (v as any).S : null
      )
      .filter(Boolean) as string[];
  }

  if (typeof attr?.S === "string") return [attr.S];

  if (typeof attr === "object") {
    const vals = Object.values(attr);
    if (vals.every(v => typeof v === "string")) return vals as string[];
  }

  return [];
}

/* Extract clinicId from query, path, or proxy */
function extractClinicId(event: APIGatewayProxyEvent): string | undefined {
  const fromQuery = event.queryStringParameters?.clinicId;
  if (fromQuery?.trim()) return fromQuery.trim();

  const fromPath = event.pathParameters?.clinicId;
  if (fromPath?.trim()) return fromPath.trim();

  const proxy = event.pathParameters?.proxy;
  if (proxy) {
    const parts = proxy.split("/").filter(Boolean);
    const last = parts[parts.length - 1];

    if (last && last !== "completed" && last !== "applications")
      return last.trim();

    if (parts[1]) return parts[1].trim();
  }

  return undefined;
}

/* Map a DynamoDB item → API response */
function mapPostingItem(item: Record<string, AttributeValue>) {
  const start_date = (item.start_date as any)?.S;
  const start_time = (item.start_time as any)?.S;

  return {
    jobId: (item.jobId as any)?.S || "No jobId",
    jobTitle: (item.professional_role as any)?.S || "No title",
    jobType: (item.job_type as any)?.S || "Not specified",
    professionalRole: (item.professional_role as any)?.S || "Not specified",

    startTime:
      start_date && start_time
        ? `${start_date} ${start_time}`
        : start_time || start_date || "Not specified",

    endTime: (item.end_time as any)?.S || "Not specified",
    status: (item.status as any)?.S || "unknown",
    clinicId: (item.clinicId as any)?.S || "unknown",

    date: (item.date as any)?.S || null,
    start_date: (item.start_date as any)?.S || null,

    hourlyRate: (item.hourly_rate as any)?.N
      ? parseFloat((item.hourly_rate as any).N)
      : null,

    salaryMin: (item.salary_min as any)?.N
      ? parseFloat((item.salary_min as any).N)
      : null,

    salaryMax: (item.salary_max as any)?.N
      ? parseFloat((item.salary_max as any).N)
      : null,

    dates: toStrArr(item.dates as any),
    dateRange:
      (item.date_range as any)?.S ||
      (item.dateRange as any)?.S ||
      null,
  };
}

/* ───────────────────────────────────────────────────────────────────────────── */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: JSON.stringify({ message: "OK" }),
      };
    }

    // Auth
    await validateToken(event);

    const clinicId = extractClinicId(event);
    if (!clinicId) {
      return json(400, {
        error: "clinicId is required (query param ?clinicId=...)",
      });
    }

    const jobs: any[] = [];
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined =
      undefined;

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

      const scanRes: ScanCommandOutput = await dynamodb.send(scanCmd);

      if (scanRes.Items?.length) {
        for (const it of scanRes.Items) {
          jobs.push(mapPostingItem(it));
        }
      }

      lastEvaluatedKey = scanRes.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // Sort by earliest date
    jobs.sort((a, b) => {
      const aKey = Array.isArray(a.dates) && a.dates[0]
        ? a.dates[0]
        : a.startTime || "";

      const bKey = Array.isArray(b.dates) && b.dates[0]
        ? b.dates[0]
        : b.startTime || "";

      return String(aKey).localeCompare(String(bKey));
    });

    return json(200, {
      message: "Completed shifts retrieved successfully",
      clinicId,
      count: jobs.length,
      jobs,
    });
    
  } catch (err: any) {
    console.error("Error retrieving completed shifts:", err);

    return json(500, {
      error: "Failed to retrieve completed shifts. Please try again.",
      details: err?.message || String(err),
    });
  }
};