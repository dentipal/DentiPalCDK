"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  BatchGetItemCommand,
  AttributeValue,
  QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
// Additive: read-time enrichment with live Clinics-table address. Never
// mutates DynamoDB; on failure the response carries the original snapshot.
import { enrichRecordsWithLiveClinicAddress } from "./clinicAddressEnricher";
const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE;
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE;

/* ─────────────────────────────────────────────────────────────────────────────
   ADD #1: Helper to normalize DynamoDB date attributes to string[]
   Works for:  [ {S:"..."}, ... ], SS, L, single S, or already-plain arrays
───────────────────────────────────────────────────────────────────────────── */
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

// ─────────────────────────────────────────────────────────────────────────────
// Helper: fetch job details from JobPostings via GSI (jobId-index)
// ─────────────────────────────────────────────────────────────────────────────

const makeJobDetailsFetcher = () => {
  const cache = new Map<string, any>();

  return async function getJobDetailsByJobId(jobId: string | undefined): Promise<any> {
    if (!jobId) return {};
    if (cache.has(jobId)) return cache.get(jobId) || {};

    const cmd = new QueryCommand({
      TableName:JOB_POSTINGS_TABLE,
      IndexName: "jobId-index-1",
      KeyConditionExpression: "jobId = :jobId",
      ExpressionAttributeValues: {
        ":jobId": { S: jobId },
      },
      Limit: 1,
    });

    try {
      const res: QueryCommandOutput = await dynamodb.send(cmd);
      const item = res.Items?.[0];
      if (!item) {
        console.error(`Job not found for jobId: ${jobId}`);
        cache.set(jobId, null);
        return {};
      }

      const details = {
        jobType: item.job_type?.S || "Not specified",
        jobTitle: item.professional_role?.S || "No title",
        professionalRole: item.professional_role?.S || "Not specified",

        startTime:
          item.start_date?.S && item.start_time?.S
            ? `${item.start_date.S} ${item.start_time.S}`
            : item.start_time?.S || item.start_date?.S || "Not specified",

        endTime: item.end_time?.S || "Not specified",

        start_date: item.start_date?.S,
        start_time: item.start_time?.S,
        date: item.date?.S,
        clinicId: item.clinicId?.S,

        rate: item.rate?.N ? parseFloat(item.rate.N) : (item.pay_type?.S === "per_transaction" ? (item.rate_per_transaction?.N ? parseFloat(item.rate_per_transaction.N) : null) : item.pay_type?.S === "percentage_of_revenue" ? (item.revenue_percentage?.N ? parseFloat(item.revenue_percentage.N) : null) : (item.hourly_rate?.N ? parseFloat(item.hourly_rate.N) : null)),
        payType: item.pay_type?.S || "per_hour",
        salaryMin: item.salary_min?.N ? parseFloat(item.salary_min.N) : null,
        salaryMax: item.salary_max?.N ? parseFloat(item.salary_max.N) : null,

        dates: toStrArr(item.dates),

        dateRange: item.date_range?.S || item.dateRange?.S || null,
        createdBy: item.created_by?.S || "",
        
      };

      cache.set(jobId, details);
      return details;
    } catch (err) {
      console.error(`Error querying JobPostings: jobId=${jobId}`, err);
      cache.set(jobId, null);
      return {};
    }
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Main handler
// ─────────────────────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(event),
        body: JSON.stringify({ message: "CORS preflight OK" }),
      };
    }

    // Extract Bearer token from Authorization header
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;

    const path = event.pathParameters?.proxy;
    const clinicId = path?.split("/")?.[1];

    if (!clinicId) {
      return {
        statusCode: 400,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: "clinicId is required in path parameters" }),
      };
    }

    const appsCmd = new QueryCommand({
      TableName:JOB_APPLICATIONS_TABLE,
      IndexName: "clinicId-jobId-index",
      KeyConditionExpression: "clinicId = :clinicId",
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId },
      },
    });

    const appsRes: QueryCommandOutput = await dynamodb.send(appsCmd);

    if (!appsRes.Items || appsRes.Items.length === 0) {
      return {
        statusCode: 404,
        headers: corsHeaders(event),
        body: JSON.stringify({ error: "No jobs found for this clinic" }),
      };
    }

    const scheduledApps = appsRes.Items.filter(
      (it) => (it.applicationStatus?.S || "").toLowerCase() === "scheduled"
    );

    const getJobDetailsByJobId = makeJobDetailsFetcher();

    const jobIds = Array.from(
      new Set(scheduledApps.map((it) => it.jobId?.S).filter(Boolean))
    );

    const detailsList = await Promise.all(
      jobIds.map((jid) => getJobDetailsByJobId(jid))
    );

    const detailsMap = new Map<string, any>();
    jobIds.forEach((jid, idx) => detailsMap.set(jid!, detailsList[idx] || {}));

    // Build the (jobId, professionalUserSub) → fromInvitation lookup against
    // the JobInvitations table. This is the source of truth for whether a
    // shift originated from an invite, independent of whether the application
    // row carries the `fromInvitation` flag (legacy data and accept-branch
    // rows historically didn't).
    const invitedPairs = new Set<string>();
    if (JOB_INVITATIONS_TABLE && scheduledApps.length > 0) {
      const inviteKeys = scheduledApps
        .filter((a) => a.jobId?.S && a.professionalUserSub?.S)
        .map((a) => ({
          jobId: { S: a.jobId!.S! },
          professionalUserSub: { S: a.professionalUserSub!.S! },
        }));
      for (let i = 0; i < inviteKeys.length; i += 100) {
        const chunk = inviteKeys.slice(i, i + 100);
        try {
          const resp = await dynamodb.send(new BatchGetItemCommand({
            RequestItems: {
              [JOB_INVITATIONS_TABLE]: {
                Keys: chunk,
                ProjectionExpression: "jobId, professionalUserSub",
              },
            },
          }));
          for (const item of (resp.Responses?.[JOB_INVITATIONS_TABLE] || [])) {
            const jid = (item.jobId as any)?.S;
            const sub = (item.professionalUserSub as any)?.S;
            if (jid && sub) invitedPairs.add(`${jid}|${sub}`);
          }
        } catch (err: any) {
          console.warn("[getScheduledShifts] fromInvitation lookup failed:", err?.message);
        }
      }
    }

    const scheduledJobs = scheduledApps.map((app) => {
      const jid = app.jobId?.S || "";
      const d = detailsMap.get(jid) || {};
      const sub = app.professionalUserSub?.S || "";
      // Three independent signals (flag, invitation-response date, JobInvitations row) —
      // OR them so the badge survives missing data in any single source.
      const isFromInvitation =
        Boolean(app.fromInvitation?.BOOL) ||
        Boolean(app.invitationResponseDate?.S) ||
        invitedPairs.has(`${jid}|${sub}`);

      return {
        jobId: jid || "No jobId",
        jobTitle: d.jobTitle || "No title",
        jobType: d.jobType || "Not specified",

        dates: d.dates || [],
        date: d.date || null,
        start_date: d.start_date || null,

        rate: d.rate || null,
        payType: d.payType || "per_hour",
        salaryMin: d.salaryMin || null,
        salaryMax: d.salaryMax || null,

        dateRange: d.dateRange || null,
        professionalRole: d.professionalRole || "Not specified",
        startTime: d.startTime || "Not specified",
        endTime: d.endTime || "Not specified",

        status: app.applicationStatus?.S || "Not specified",
        clinicId: clinicId,
        professionalUserSub: sub || undefined,
        fromInvitation: isFromInvitation,
      };
    });

    // Additive: refresh address fields on each scheduled job with the live
    // Clinics-table values. DB rows are NOT mutated; on failure we log and
    // continue with the original snapshot.
    let jobsForResponse: any[] = scheduledJobs as any[];
    try {
      jobsForResponse = (await enrichRecordsWithLiveClinicAddress(scheduledJobs as any[])) as any[];
    } catch (enrichErr) {
      console.warn(
        "[getScheduledShifts] live clinic-address enrichment skipped:",
        (enrichErr as Error)?.message
      );
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        message: "Scheduled jobs retrieved successfully",
        jobs: jobsForResponse,
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving scheduled jobs:", error);

    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({
        error: "Failed to retrieve scheduled jobs. Please try again.",
        details: error.message,
      }),
    };
  }
};
