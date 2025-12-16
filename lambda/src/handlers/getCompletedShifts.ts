"use strict";

import {
  DynamoDBClient,
  QueryCommand, // Changed from ScanCommand to QueryCommand
  QueryCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

import { extractUserFromBearerToken } from "./utils.js";
import { CORS_HEADERS } from "./corsHeaders";

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!; // Use Env Var

const dynamodb = new DynamoDBClient({ region: REGION });

// Helper to build JSON responses
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

/* ─────────────────────────────────────────────────────────────────────────────
   Helper: Normalize DynamoDB attributes
───────────────────────────────────────────────────────────────────────────── */
function toStrArr(attr: any): string[] {
  if (!attr) return [];
  if (Array.isArray(attr) && attr.every(v => typeof v === "string")) return attr;
  if (Array.isArray(attr?.SS)) return attr.SS;
  if (Array.isArray(attr?.L)) {
    return attr.L
      .map((v: AttributeValue) => (v && typeof (v as any).S === "string" ? (v as any).S : null))
      .filter(Boolean) as string[];
  }
  if (typeof attr?.S === "string") return [attr.S];
  return [];
}

/* Helper: Map DynamoDB item to Response Object */
function mapPostingItem(item: Record<string, AttributeValue>) {
  const start_date = (item.start_date as any)?.S;
  const start_time = (item.start_time as any)?.S;

  return {
    jobId: (item.jobId as any)?.S || "No jobId",
    clinicUserSub: (item.clinicUserSub as any)?.S || "No userSub", // Changed from clinicId
    status: (item.status as any)?.S || "unknown",
    
    // details
    jobTitle: (item.professional_role as any)?.S || "No title",
    jobType: (item.job_type as any)?.S || "Not specified",
    professionalRole: (item.professional_role as any)?.S || "Not specified",

    startTime: start_date && start_time ? `${start_date} ${start_time}` : (start_time || start_date || "Not specified"),
    endTime: (item.end_time as any)?.S || "Not specified",

    date: (item.date as any)?.S || null,
    start_date: (item.start_date as any)?.S || null,

    hourlyRate: (item.hourly_rate as any)?.N ? parseFloat((item.hourly_rate as any).N) : null,
    salaryMin: (item.salary_min as any)?.N ? parseFloat((item.salary_min as any).N) : null,
    salaryMax: (item.salary_max as any)?.N ? parseFloat((item.salary_max as any).N) : null,

    dates: toStrArr(item.dates as any),
    dateRange: (item.date_range as any)?.S || (item.dateRange as any)?.S || null,
    
    // Completion details (if available)
    completedAt: (item.completedAt as any)?.S || null,
    completionNotes: (item.completionNotes as any)?.S || null,
  };
}

/* ───────────────────────────────────────────────────────────────────────────── */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // 1. Auth & Identity Extraction
    let userSub: string;
    try {
      const authHeader = event.headers?.Authorization || event.headers?.authorization;
      const userInfo = extractUserFromBearerToken(authHeader);
      userSub = userInfo.sub;
    } catch (authError: any) {
      return json(401, { error: authError.message || "Invalid access token" });
    }

    // 2. Query DynamoDB (More efficient than Scan)
    // We fetch all jobs for this user where status = 'completed'
    const jobs: any[] = [];
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined = undefined;

    do {
      const queryCmd = new QueryCommand({
        TableName: JOB_POSTINGS_TABLE,
        // Query by Partition Key (clinicUserSub)
        KeyConditionExpression: "clinicUserSub = :sub",
        // Filter results by Status
        FilterExpression: "#st = :status",
        ExpressionAttributeValues: {
          ":sub": { S: userSub },
          ":status": { S: "completed" } // Looking for 'completed' jobs
        },
        ExpressionAttributeNames: {
          "#st": "status", // Map reserved word 'status'
        },
        ExclusiveStartKey: lastEvaluatedKey,
      });

      const queryRes: QueryCommandOutput = await dynamodb.send(queryCmd);

      if (queryRes.Items?.length) {
        for (const it of queryRes.Items) {
          jobs.push(mapPostingItem(it));
        }
      }

      lastEvaluatedKey = queryRes.LastEvaluatedKey;
    } while (lastEvaluatedKey);

    // 3. Sort by earliest date
    jobs.sort((a, b) => {
      const aKey = Array.isArray(a.dates) && a.dates[0] ? a.dates[0] : a.startTime || "";
      const bKey = Array.isArray(b.dates) && b.dates[0] ? b.dates[0] : b.startTime || "";
      return String(aKey).localeCompare(String(bKey));
    });

    return json(200, {
      message: "Completed shifts retrieved successfully",
      clinicUserSub: userSub,
      count: jobs.length,
      jobs,
    });
    
  } catch (err: any) {
    console.error("Error retrieving completed shifts:", err);
    return json(500, {
      error: "Failed to retrieve completed shifts.",
      details: err?.message || String(err),
    });
  }
};