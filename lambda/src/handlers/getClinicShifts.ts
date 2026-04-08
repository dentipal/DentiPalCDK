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
const SCHEDULED_STATUSES = (process.env.SCHEDULED_STATUSES || "scheduled,accepted,booked")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const COMPLETED_STATUSES = (process.env.COMPLETED_STATUSES || "completed,paid")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const TERMINAL_IGNORE_STATUSES = (process.env.TERMINAL_IGNORE_STATUSES || "rejected,cancelled,declined")
  .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

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

    // 1. Authentication
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const requesterSub = userInfo?.sub || "";
    
    // 2. Extract clinicId from path parameters
    const proxy = event.pathParameters?.proxy || "";
    const pathParts = proxy.split('/');
    let targetClinicId = event.pathParameters?.clinicId || "";
    if (!targetClinicId && pathParts.length >= 2) {
      targetClinicId = pathParts[1]; // fallback logic
    }

    if (!targetClinicId) {
      return json(400, { error: "clinicId is required in the path" });
    }

    // Identify which dataset to return
    const isActionNeeded = proxy.includes('action-needed');
    const isScheduled = proxy.includes('scheduled-shifts');
    const isCompleted = proxy.includes('completed-shifts');
    const isInvites = proxy.includes('invites');
    const isOpen = proxy.includes('open-shifts');

    // 3. Fetch shifts for the owner's sub, we will filter for the specific clinicId
    // We assume the user owns the clinic, so clinicUserSub = requesterSub.
    const clinicUserSub = requesterSub;
    
    const shiftsItems = await queryAll({
      TableName: JOB_POSTINGS_TABLE,
      KeyConditionExpression: "clinicUserSub = :cus",
      ExpressionAttributeValues: {
        ":cus": { S: clinicUserSub },
      },
    });

    // Filter shifts for this particular clinicId early
    const allShifts = shiftsItems
      .filter(it => s(it.clinicId) === targetClinicId)
      .map((it) => ({
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
      location: s(it.location) || s(it.addressLine1),
      fullAddress: s(it.fullAddress) || s(it.addressLine1),
      city: s(it.city),
      state: s(it.state),
      shiftDetails: s(it.shiftDetails),
      status: s(it.status) || "unknown",
      createdAt: s(it.createdAt),
      createdBy: s(it.createdBy) || s(it.created_by),
      creatorName: s(it.creatorName) || s(it.createdBy),
    }));

    const jobMap = new Map<string, any>();
    allShifts.forEach((sh) => {
      if (sh.jobId) jobMap.set(sh.jobId, sh);
    });

    // 4. Fetch Applications specifically for this clinicId
    let applicationItems: any[] = [];
    if (allShifts.length > 0) {
      applicationItems = await queryAll({
        TableName: JOB_APPLICATIONS_TABLE,
        IndexName: JOB_APPLICATIONS_CLINIC_GSI,
        KeyConditionExpression: "clinicId = :cid",
        ExpressionAttributeValues: {
          ":cid": { S: targetClinicId },
        },
      });
    }

    // 5. Enrich Applications with Job Data
    const appsEnriched = applicationItems.map((it) => {
      const jobId = s(it.jobId);
      const job = jobMap.get(jobId) || {};
      const status = normalizeStatus(it.applicationStatus);

      return {
        ...job, // Bring in all job properties
        
        applicationId: s(it.applicationId),
        clinicId: s(it.clinicId),
        jobId,
        professionalUserSub: s(it.professionalUserSub),
        professionalName: s(it.professionalName) || "Professional",
        applicationStatus: status,
        appliedAt: s(it.appliedAt),
        proposedRate: n(it.proposedRate) ?? n(it.proposed_rate),
        negotiationId: s(it.negotiationId),

        jobTitle: job.jobTitle || "No Title",
        hourlyRate: job.hourlyRate || null,
      };
    });

    // 6. Categorize the target subset
    let responseData: any[] = [];

    const scheduledJobIds = new Set();
    const completedJobIds = new Set();

    if (isScheduled || isOpen || isActionNeeded) {
      const scheduledJobs = appsEnriched.filter((a) =>
        SCHEDULED_STATUSES.includes(a.applicationStatus)
      );
      scheduledJobs.forEach(a => scheduledJobIds.add(a.jobId));
      if (isScheduled) responseData = scheduledJobs;
    }

    if (isCompleted || isOpen || isActionNeeded) {
      const completedJobs = appsEnriched.filter((a) =>
        COMPLETED_STATUSES.includes(a.applicationStatus)
      );
      completedJobs.forEach(a => completedJobIds.add(a.jobId));
      if (isCompleted) responseData = completedJobs;
    }

    if (isActionNeeded) {
      const actionNeededJobs = appsEnriched.filter((a) => {
        const st = a.applicationStatus;
        if (!st) return true;
        if (SCHEDULED_STATUSES.includes(st)) return false;
        if (COMPLETED_STATUSES.includes(st)) return false;
        if (TERMINAL_IGNORE_STATUSES.includes(st)) return false;
        return true;
      });

      const profSubs = [...new Set(actionNeededJobs.map((a: any) => a.professionalUserSub).filter(Boolean))];
      const profilesMap = new Map();

      if (process.env.PROFILES_TABLE && profSubs.length > 0) {
        const { BatchGetItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
        const { unmarshall } = require("@aws-sdk/util-dynamodb");
        for (let i = 0; i < profSubs.length; i += 100) {
          const chunk = profSubs.slice(i, i + 100);
          try {
            const resp: any = await dynamodb.send(new BatchGetItemCommand({ RequestItems: { [process.env.PROFILES_TABLE]: { Keys: chunk.map((s: any) => ({ userSub: { S: s } })) } } }));
            const arr = resp.Responses?.[process.env.PROFILES_TABLE] || [];
            arr.forEach((item: any) => {
              const p = unmarshall(item);
              profilesMap.set(p.userSub, p);
            });
          } catch(e) { console.error("Profile fetch error", e); }
        }

        // Add negotiation fetching
        for(const app of actionNeededJobs as any[]) {
           if((app.applicationStatus || "").toLowerCase() === "negotiating" && process.env.JOB_NEGOTIATIONS_TABLE) {
              try {
                const negoResp: any = await dynamodb.send(new QueryCommand({
                  TableName: process.env.JOB_NEGOTIATIONS_TABLE,
                  IndexName: "applicationId-index",
                  KeyConditionExpression: "applicationId = :aid",
                  ExpressionAttributeValues: { ":aid": { S: app.applicationId } }
                }));
                const items = (negoResp.Items || []).map((it:any) => unmarshall(it));
                if (items.length) {
                  items.sort((a:any, b:any)=> new Date(b.updatedAt||b.createdAt||0).getTime() - new Date(a.updatedAt||a.createdAt||0).getTime());
                  app.negotiation = items[0];
                }
              } catch(e){}
           }
           app.professional = profilesMap.get(app.professionalUserSub) || null;
           app.professionalName = app.professional?.first_name ? `${app.professional.first_name} ${app.professional.last_name || ''}`.trim() : app.professionalName;
        }
      }

      responseData = actionNeededJobs;
    }

    if (isOpen) {
      const openShifts = allShifts.filter((job) => {
        if (scheduledJobIds.has(job.jobId)) return false;
        if (completedJobIds.has(job.jobId)) return false;
        const jobStatus = normalizeStatus(job.status);
        if (TERMINAL_IGNORE_STATUSES.includes(jobStatus)) return false;
        return true;
      });
      responseData = openShifts;
    }

    if (isInvites) {
      if (process.env.JOB_INVITATIONS_TABLE) {
        // Scan invitations for the target clinic
        const { ScanCommand } = require("@aws-sdk/client-dynamodb");
        let inviteItems: any[] = [];
        let lastKey;
        do {
          const res: any = await dynamodb.send(new ScanCommand({
            TableName: process.env.JOB_INVITATIONS_TABLE,
            FilterExpression: "clinicId = :cid",
            ExpressionAttributeValues: {
              ":cid": { S: targetClinicId }
            },
            ExclusiveStartKey: lastKey
          }));
          if (res.Items) inviteItems.push(...res.Items);
          lastKey = res.LastEvaluatedKey;
        } while (lastKey);

        // Map and enrich invites
        responseData = inviteItems.map(item => {
          const jobId = s(item.jobId);
          const job = jobMap.get(jobId) || {};
          
          return {
            ...job, // Bring in all job properties
            
            invitationId: s(item.invitationId),
            jobId: jobId,
            clinicId: s(item.clinicId),
            professionalUserSub: s(item.professionalUserSub),
            professionalName: "Professional", // Could be fetched if needed
            invitationStatus: s(item.invitationStatus) || "pending",
            applicationStatus: s(item.invitationStatus) || "pending", // fallback for table column
            sentAt: s(item.sentAt),
            appliedAt: s(item.sentAt), // map to appliedAt for the shared shift table
            updatedAt: s(item.updatedAt),
            message: s(item.message),
            rateOffered: n(item.rateOffered),
            
            jobTitle: job.jobTitle || "No Title",
            hourlyRate: job.hourlyRate || null,
          };
        });
      } else {
        responseData = []; 
      }
    }

    return json(200, {
      message: "Clinic shifts retrieved successfully.",
      data: responseData,
    });
  } catch (error: any) {
    console.error("Error retrieving clinic specific shifts:", error);
    return json(500, { error: "Failed to retrieve shifts.", details: error.message });
  }
};
