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
    console.log(`[getAllClinicsShifts] Executing data fetch for userSub requests: ${requesterSub}`);

    let clinicUserSub = extractClinicUserSub(event);
    if (!clinicUserSub) {
      console.warn(`[getAllClinicsShifts] Execution halted: Missing clinicUserSub from URL mapping`);
      return json(400, { error: "clinicUserSub is required in the path" });
    }

    // FIX: If the path is /dashboard/all/..., the extracted sub evaluates to "all".
    // Since the user is fetching their own clinics, we override it to their token's sub.
    if (clinicUserSub === "all") {
      clinicUserSub = requesterSub;
    }

    console.log(`[getAllClinicsShifts] Target clinic owner Sub parsed: ${clinicUserSub}`);

    const groups: string[] = (userInfo?.groups || userInfo?.["cognito:groups"] || []) as string[];
    const isRoot = Array.isArray(groups) && groups.includes("Root");

    if (!isRoot && requesterSub && requesterSub !== clinicUserSub) {
      console.warn(`[getAllClinicsShifts] Security Block: User ${requesterSub} attempted to fetch foreign data map for ${clinicUserSub}`);
      return json(403, { error: "Forbidden: You can only access your own clinic data" });
    }

    // 2. Fetch All Shifts (Postings) for this Clinic User
    console.log(`[getAllClinicsShifts] Initiating DynamoDB query sweep on JOB_POSTINGS_TABLE for clinicUserSub...`);
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
    console.log(`[getAllClinicsShifts] Aggregated successfully: ${allShifts.length} base shifts matched spread across ${clinicIds.length} unique underlying clinics.`);

    // 3. Fetch All Applications (if any clinics exist)
    const applicationItems: any[] = [];
    if (clinicIds.length > 0) {
      console.log(`[getAllClinicsShifts] Pinging JOB_APPLICATIONS_TABLE for ${clinicIds.length} targeted clinics...`);
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
      console.log(`[getAllClinicsShifts] Grabbed identical match for ${applicationItems.length} active applications tied to these clinics.`);
    } else {
      console.log(`[getAllClinicsShifts] Sweeper detected exactly 0 clinics for this user. Application fetch skipped.`);
    }

    // 4. Enrich Applications with Job Data
    console.log(`[getAllClinicsShifts] Initializing mapping unification to tie shifts to application entities...`);
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

    const unifiedResponse = {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "All clinics jobs and applications categorized successfully.",
        metadata: {
          openJobs: openShifts.length,
          actionNeededJobs: actionNeededJobs.length,
          scheduledJobs: scheduledJobs.length,
          completedJobs: completedJobs.length,
          totalShifts: allShifts.length,
        },
        data: {
          openShifts,
          scheduledJobs,
          actionNeededJobs,
          completedJobs,
        }
      })
    };
    
    // Group the categorized shifts by clinic ID
    const groupedOpenShifts: Record<string, any[]> = {};
    const groupedActionNeeded: Record<string, any[]> = {};
    const groupedScheduled: Record<string, any[]> = {};
    const groupedCompleted: Record<string, any[]> = {};
    const groupedInvites: Record<string, any[]> = {};

    openShifts.forEach((job) => {
      const cid = job.clinicId || "unknown";
      if (!groupedOpenShifts[cid]) groupedOpenShifts[cid] = [];
      groupedOpenShifts[cid].push(job);
    });

    actionNeededJobs.forEach((job) => {
      const cid = job.clinicId || "unknown";
      if (!groupedActionNeeded[cid]) groupedActionNeeded[cid] = [];
      groupedActionNeeded[cid].push(job);
    });

    scheduledJobs.forEach((job) => {
      const cid = job.clinicId || "unknown";
      if (!groupedScheduled[cid]) groupedScheduled[cid] = [];
      groupedScheduled[cid].push(job);
    });

    completedJobs.forEach((job) => {
      const cid = job.clinicId || "unknown";
      if (!groupedCompleted[cid]) groupedCompleted[cid] = [];
      groupedCompleted[cid].push(job);
    });

    // You can also populate invites here if retrieved, keeping empty for placeholder
    const payloadMap: Record<string, any> = {
      open: groupedOpenShifts,
      action: groupedActionNeeded,
      scheduled: groupedScheduled,
      completed: groupedCompleted,
      invites: groupedInvites,
    };

    const path = event.path || (event as any).rawPath || "";
    console.log(`[getAllClinicsShifts] Incoming request path: ${path}`);
    console.log(`[getAllClinicsShifts] Total Clinics Grouped -> Open: ${Object.keys(groupedOpenShifts).length}, Scheduled: ${Object.keys(groupedScheduled).length}, Completed: ${Object.keys(groupedCompleted).length}`);

    let finalData: any = {
      openShifts: groupedOpenShifts,
      actionNeededJobs: groupedActionNeeded,
      scheduledJobs: groupedScheduled,
      completedJobs: groupedCompleted,
      invitesShifts: groupedInvites,
    };

    if (path.includes("open-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: open-shifts. Serving groupedOpenShifts.");
      finalData = payloadMap.open;
    } else if (path.includes("action-needed")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: action-needed. Serving groupedActionNeeded.");
      finalData = payloadMap.action;
    } else if (path.includes("scheduled-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: scheduled-shifts. Serving groupedScheduled.");
      finalData = payloadMap.scheduled;
    } else if (path.includes("completed-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: completed-shifts. Serving groupedCompleted.");
      finalData = payloadMap.completed;
    } else if (path.includes("invites-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: invites-shifts. Serving groupedInvites.");
      finalData = payloadMap.invites;
    } else {
       console.log("[getAllClinicsShifts] No specific sub-route matched. Returning massive aggregated block.");
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "All clinics categorized shifts successfully retrieved.",
        data: finalData,
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving all clinic shifts:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: "Failed to retrieve shifts.", details: error.message }),
    };
  }
};