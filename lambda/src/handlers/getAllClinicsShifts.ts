"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
  QueryCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE;
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE;

// Optional envs (defaults provided)
const JOB_APPLICATIONS_CLINIC_GSI =
  process.env.JOB_APPLICATIONS_CLINIC_GSI || "clinicId-jobId-index";

// --- Status Configurations ---

// 1. Scheduled: The job is filled/booked
const SCHEDULED_STATUSES = (process.env.SCHEDULED_STATUSES || "scheduled,accepted,booked")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 2. Completed: The job is done
const COMPLETED_STATUSES = (process.env.COMPLETED_STATUSES || "completed,paid")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 3. Ignored: These don't require action and don't count as "open" or "filled"
const TERMINAL_IGNORE_STATUSES = (process.env.TERMINAL_IGNORE_STATUSES || "rejected,cancelled,declined")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/* ----------------------------- Helpers ----------------------------- */

const json = (statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

const s = (attr?: AttributeValue): string => {
  if (!attr || !("S" in attr)) return "";
  return (attr.S as string) || "";
};

const n = (attr?: AttributeValue): number | null => {
  if (!attr || !("N" in attr)) return null;
  const v = Number(attr.N);
  return Number.isFinite(v) ? v : null;
};

function toStrArr(attr: any): string[] {
  if (!attr) return [];
  if (Array.isArray(attr) && typeof attr[0] === "string") return attr;
  if (Array.isArray(attr?.SS)) return attr.SS;
  if (Array.isArray(attr?.L)) {
    return attr.L
      .map((v: any) => (v && typeof v.S === "string" ? v.S : null))
      .filter(Boolean);
  }
  if (typeof attr?.S === "string") return [attr.S];
  if (typeof attr === "object") {
    const vals = Object.values(attr);
    if (vals.every((v) => typeof v === "string")) return vals as string[];
  }
  return [];
}

async function queryAll(input: QueryCommandInput): Promise<any[]> {
  const items: any[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;

  do {
    const res: QueryCommandOutput = await dynamodb.send(
      new QueryCommand({ ...input, ExclusiveStartKey })
    );
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

function extractClinicUserSub(event: APIGatewayProxyEvent): string {
  // Support: /clinic/<sub/..., /dashboard/<sub>, /<sub>
  // Uses existing proxy logic so no stack changes are needed
  const proxy = event.pathParameters?.proxy || "";
  const segments = proxy.split("/").filter(Boolean);

  const clinicIdx = segments.indexOf("clinic");
  if (clinicIdx >= 0 && segments[clinicIdx + 1]) return segments[clinicIdx + 1];

  if (segments[0] === "dashboard" && segments[1]) return segments[1];

  // fallback
  return segments[0] || "";
}

function normalizeStatus(raw: any): string {
  return (raw?.S || raw || "").toString().trim().toLowerCase();
}

/* ----------------------------- Main Handler ----------------------------- */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(200, { message: "CORS preflight OK" });
    }

    if (!JOB_POSTINGS_TABLE || !JOB_APPLICATIONS_TABLE) {
      return json(500, { error: "Missing DynamoDB table env vars" });
    }

    // 1. Authentication & Authorization
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const requesterSub = userInfo?.sub || "";

    const clinicUserSub = extractClinicUserSub(event);
    if (!clinicUserSub) {
      return json(400, { error: "clinicUserSub is required in the path" });
    }

    const groups: string[] = (userInfo?.groups || userInfo?.["cognito:groups"] || []) as string[];
    const isRoot = Array.isArray(groups) && groups.includes("Root");

    if (!isRoot && requesterSub && requesterSub !== clinicUserSub) {
      return json(403, { error: "Forbidden: You can only access your own clinic data" });
    }

    // 2. Fetch All Shifts (Postings) for this Clinic User
    const shiftsItems = await queryAll({
      TableName: JOB_POSTINGS_TABLE,
      KeyConditionExpression: "clinicUserSub = :cus",
      ExpressionAttributeValues: {
        ":cus": { S: clinicUserSub },
      },
    });

    const allShifts = shiftsItems.map((it) => ({
      clinicUserSub,
      clinicId: s(it.clinicId),
      jobId: s(it.jobId),
      jobTitle: s(it.professional_role) || s(it.jobTitle),
      professionalRole: s(it.professional_role),
      jobType: s(it.job_type),
      date: s(it.date),
      start_date: s(it.start_date),
      start_time: s(it.start_time),
      end_time: s(it.end_time),
      dates: toStrArr(it.dates),
      dateRange: s(it.date_range) || s(it.dateRange),
      hourlyRate: n(it.hourly_rate),
      salaryMin: n(it.salary_min),
      salaryMax: n(it.salary_max),
      status: s(it.status) || "unknown",
      createdAt: s(it.createdAt),
    }));

    // Build helper map for enriching applications later
    const jobMap = new Map<string, any>();
    allShifts.forEach((sh) => {
      if (sh.jobId) jobMap.set(sh.jobId, sh);
    });

    // Get unique Clinic IDs to query applications
    const clinicIds = Array.from(new Set(allShifts.map((x) => x.clinicId).filter(Boolean)));

    // 3. Fetch All Applications (if any clinics exist)
    const applicationItems: any[] = [];
    if (clinicIds.length > 0) {
      for (const clinicId of clinicIds) {
        const apps = await queryAll({
          TableName: JOB_APPLICATIONS_TABLE,
          IndexName: JOB_APPLICATIONS_CLINIC_GSI,
          KeyConditionExpression: "clinicId = :cid",
          ExpressionAttributeValues: {
            ":cid": { S: clinicId },
          },
        });
        applicationItems.push(...apps);
      }
    }

    // 4. Enrich Applications with Job Data
    const appsEnriched = applicationItems.map((it) => {
      const jobId = s(it.jobId);
      const job = jobMap.get(jobId) || {};
      const status = normalizeStatus(it.applicationStatus);

      return {
        // Application Details
        applicationId: s(it.applicationId),
        clinicId: s(it.clinicId),
        jobId,
        professionalUserSub: s(it.professionalUserSub),
        professionalName: s(it.professionalName) || "Professional", 
        applicationStatus: status,
        appliedAt: s(it.appliedAt),
        proposedRate: n(it.proposedRate) ?? n(it.proposed_rate),
        negotiationId: s(it.negotiationId),
        
        // Enriched Job Details
        jobTitle: job.jobTitle || "No Title",
        date: job.date || null,
        start_time: job.start_time || null,
        end_time: job.end_time || null,
        hourlyRate: job.hourlyRate || null,
      };
    });

    // 5. Categorize (Bucketing Logic)

    // A. Scheduled Jobs: Confirmed/Booked applications
    const scheduledJobs = appsEnriched.filter((a) => 
      SCHEDULED_STATUSES.includes(a.applicationStatus)
    );

    // B. Completed Jobs: Finished/Paid applications
    const completedJobs = appsEnriched.filter((a) => 
      COMPLETED_STATUSES.includes(a.applicationStatus)
    );

    // C. Action Needed: Pending applications (applied, negotiating, etc.)
    const actionNeededJobs = appsEnriched.filter((a) => {
      const st = a.applicationStatus;
      if (!st) return true;
      if (SCHEDULED_STATUSES.includes(st)) return false;
      if (COMPLETED_STATUSES.includes(st)) return false;
      if (TERMINAL_IGNORE_STATUSES.includes(st)) return false;
      return true;
    });

    // D. Open Shifts: 
    //    Jobs from `allShifts` that DO NOT have a Scheduled or Completed application.
    const scheduledJobIds = new Set(scheduledJobs.map(a => a.jobId));
    const completedJobIds = new Set(completedJobs.map(a => a.jobId));

    const openShifts = allShifts.filter((job) => {
      // If job is already filled or done, it's not open
      if (scheduledJobIds.has(job.jobId)) return false;
      if (completedJobIds.has(job.jobId)) return false;
      
      // If the job itself was cancelled by the clinic
      const jobStatus = normalizeStatus(job.status);
      if (TERMINAL_IGNORE_STATUSES.includes(jobStatus)) return false;

      return true;
    });

    // 6. Response
    return json(200, {
      clinicUserSub,
      counts: {
        openShifts: openShifts.length,
        scheduledJobs: scheduledJobs.length,
        actionNeededJobs: actionNeededJobs.length,
        completedJobs: completedJobs.length,
        totalShifts: allShifts.length,
      },
      data: {
        openShifts,       // Jobs that no one has taken yet
        scheduledJobs,    // Applications that are booked
        actionNeededJobs, // Applications waiting for your review
        completedJobs,    // Applications that are finished
      }
    });

  } catch (error: any) {
    console.error("Error fetching clinic jobs details:", error);
    return json(500, {
      error: "Failed to fetch clinic jobs details",
      details: error?.message || String(error),
    });
  }
};