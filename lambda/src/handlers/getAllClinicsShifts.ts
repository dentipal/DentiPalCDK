"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  QueryCommandInput,
  QueryCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { CognitoIdentityProviderClient, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot, listAccessibleClinicIds } from "./utils";
import { ScanCommand } from "@aws-sdk/client-dynamodb";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const USER_POOL_ID = process.env.USER_POOL_ID || "";

const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE;
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE;

// Optional envs (defaults provided)
const JOB_APPLICATIONS_CLINIC_GSI =
  process.env.JOB_APPLICATIONS_CLINIC_GSI || "clinicId-jobId-index";
const JOB_POSTINGS_CLINIC_GSI = process.env.JOB_POSTINGS_CLINIC_GSI || "ClinicIdIndex";
const CLINICS_TABLE = process.env.CLINICS_TABLE;

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

const b = (attr?: AttributeValue): boolean => {
  if (!attr || !("BOOL" in attr)) return false;
  return Boolean(attr.BOOL);
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

async function scanAllClinicIds(): Promise<string[]> {
  if (!CLINICS_TABLE) {
    console.error("[getAllClinicsShifts] CLINICS_TABLE env var is not set; cannot enumerate clinics for Root.");
    return [];
  }
  const clinicIds: string[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
  do {
    const resp: any = await dynamodb.send(new ScanCommand({
      TableName: CLINICS_TABLE,
      ProjectionExpression: "clinicId",
      ExclusiveStartKey,
    }));
    for (const item of resp.Items || []) {
      const id = item.clinicId?.S;
      if (id) clinicIds.push(id);
    }
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return clinicIds;
}

function normalizeStatus(raw: any): string {
  return (raw?.S || raw || "").toString().trim().toLowerCase();
}

/**
 * Resolve created_by to a display name:
 *  - If it contains a space (already a name), return as-is
 *  - If it's an email (contains @), extract the part before @
 *  - If it's a userSub, look up Cognito for given_name + family_name
 */
async function resolveCreatorName(createdBy: string): Promise<string> {
  if (!createdBy) return "";
  if (createdBy.includes(" ")) return createdBy;
  if (createdBy.includes("@")) return createdBy.split("@")[0];
  if (!USER_POOL_ID) return createdBy;
  try {
    const cognitoUser = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: createdBy }));
    const attrs = cognitoUser.UserAttributes || [];
    const first = attrs.find(a => a.Name === "given_name")?.Value || "";
    const last = attrs.find(a => a.Name === "family_name")?.Value || "";
    const name = `${first} ${last}`.trim();
    return name || createdBy;
  } catch {
    return createdBy;
  }
}

/* ----------------------------- Main Handler ----------------------------- */

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
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
    const groups: string[] = Array.isArray(userInfo?.groups) ? userInfo.groups : [];
    console.log(`[getAllClinicsShifts] Executing data fetch for userSub: ${requesterSub}`);

    // Determine which clinics this user may read across.
    // Root → every clinic in the system. Non-root → only clinics they appear in
    // (Clinics.AssociatedUsers or createdBy). Shared membership check with canAccessClinic.
    let targetClinicIds: string[];
    if (isRoot(groups)) {
      targetClinicIds = await scanAllClinicIds();
      console.log(`[getAllClinicsShifts] Root user; enumerated ${targetClinicIds.length} clinics.`);
    } else {
      const accessible = await listAccessibleClinicIds(requesterSub, groups);
      targetClinicIds = accessible ?? [];
      console.log(`[getAllClinicsShifts] Non-root user; ${targetClinicIds.length} accessible clinics.`);
    }

    if (targetClinicIds.length === 0) {
      return json(200, {
        message: "No clinics accessible for this user.",
        data: {},
      });
    }

    // 2. Fetch Shifts (Postings) for every accessible clinic via the ClinicIdIndex GSI.
    //    Previously we queried JobPostings by clinicUserSub == requester, which only matched
    //    the clinic owner — non-owner admins/managers/viewers got an empty dashboard.
    console.log(`[getAllClinicsShifts] Querying JOB_POSTINGS_TABLE via ${JOB_POSTINGS_CLINIC_GSI} for ${targetClinicIds.length} clinics...`);
    const shiftsItemsGrouped = await Promise.all(
      targetClinicIds.map((cid) => queryAll({
        TableName: JOB_POSTINGS_TABLE,
        IndexName: JOB_POSTINGS_CLINIC_GSI,
        KeyConditionExpression: "clinicId = :cid",
        ExpressionAttributeValues: { ":cid": { S: cid } },
      }))
    );
    const shiftsItems = shiftsItemsGrouped.flat();

    const allShifts = shiftsItems.map((it) => ({
      clinicUserSub: s(it.clinicUserSub),
      clinicId: s(it.clinicId),
      jobId: s(it.jobId),
      jobTitle: s(it.professional_role) || s(it.jobTitle),
      professionalRole: s(it.professional_role),
      professionalRoles: toStrArr(it.professional_roles),
      jobType: s(it.job_type),
      date: s(it.date),
      start_date: s(it.start_date),
      start_time: s(it.start_time),
      end_time: s(it.end_time),
      dates: toStrArr(it.dates),
      dateRange: s(it.date_range) || s(it.dateRange),
      rate: (() => {
        const pt = s(it.pay_type);
        if (pt === "per_transaction") return n(it.rate_per_transaction) ?? n(it.rate) ?? 0;
        if (pt === "percentage_of_revenue") return n(it.revenue_percentage) ?? n(it.rate) ?? 0;
        return n(it.rate) ?? n(it.hourly_rate) ?? 0;
      })(),
      payType: s(it.pay_type) || "per_hour",
      salaryMin: n(it.salary_min),
      salaryMax: n(it.salary_max),
      workLocationType: s(it.work_location_type),
      location: s(it.location) || s(it.addressLine1),
      fullAddress: s(it.fullAddress) || s(it.addressLine1),
      city: s(it.city),
      state: s(it.state),
      shiftDetails: s(it.shiftDetails),
      status: s(it.status) || "unknown",
      clinicSoftware: toStrArr(it.clinicSoftware),
      freeParkingAvailable: b(it.freeParkingAvailable),
      parkingType: s(it.parkingType),
      shiftSpeciality: s(it.shift_speciality),
      jobDescription: s(it.job_description),
      mealBreak: s(it.meal_break),
      requirements: toStrArr(it.requirements),
      createdAt: s(it.createdAt),
      createdBy: s(it.createdBy) || s(it.created_by),
      creatorName: s(it.creatorName),
      // Promotion fields
      isPromoted: b(it.isPromoted),
      promotionPlanId: s(it.promotionPlanId),
      promotionId: s(it.promotionId),
      promotionExpiresAt: s(it.promotionExpiresAt),
    }));

    // Resolve creator names for records without creatorName (old records with userSub)
    const creatorCache = new Map<string, string>();
    for (const shift of allShifts) {
      if (shift.creatorName) continue;
      const raw = shift.createdBy;
      if (!raw || creatorCache.has(raw)) continue;
      const name = await resolveCreatorName(raw);
      creatorCache.set(raw, name);
    }
    for (const shift of allShifts) {
      if (!shift.creatorName) {
        shift.creatorName = creatorCache.get(shift.createdBy) || shift.createdBy;
      }
    }

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

      // Use accepted/negotiated rate if available, otherwise fall back to original job rate
      const acceptedRate = n(it.acceptedHourlyRate) ?? n(it.acceptedRate) ?? n(it.accepted_hourly_rate) ?? n(it.accepted_rate);
      const finalRate = acceptedRate ?? job.rate ?? null;

      return {
        ...job, // Bring in all job properties

        // Application Details OVERRIDING
        applicationId: s(it.applicationId),
        clinicId: s(it.clinicId),
        jobId,
        professionalUserSub: s(it.professionalUserSub),
        professionalName: s(it.professionalName) || "Professional",
        applicationStatus: status,
        appliedAt: s(it.appliedAt),
        proposedRate: n(it.proposedRate) ?? n(it.proposed_rate),
        negotiationId: s(it.negotiationId),
        acceptedHourlyRate: acceptedRate,

        // Enriched Job Details
        jobTitle: job.jobTitle || "No Title",
        rate: finalRate,
        payType: job.payType || "per_hour",
      };
    });

    // 5. Categorize (Bucketing Logic)
    
    const now = new Date();
    // Dynamically mark scheduled jobs as completed if their time has passed
    appsEnriched.forEach(a => {
      if (SCHEDULED_STATUSES.includes(a.applicationStatus)) {
        const jobDate = a.date || a.start_date || a.jobDate || a.shiftDate;
        const jobEndTime = a.end_time || a.endTime || a.shiftEndTime;
        
        if (jobDate) {
           try {
              const jobDateTime = new Date(jobDate);
              if (jobEndTime) {
                 // Safely parse time considering AM/PM formats
                 const timeStr = String(jobEndTime).toLowerCase().trim();
                 const isPM = timeStr.includes('pm') || timeStr.includes('p.m.');
                 const isAM = timeStr.includes('am') || timeStr.includes('a.m.');
                 const cleanTime = timeStr.replace(/[^0-9:]/g, ''); // keeps only numbers and colons
                 
                 const [hToken, mToken] = cleanTime.split(':');
                 let hours = parseInt(hToken, 10);
                 const minutes = parseInt(mToken, 10) || 0;

                 if (!isNaN(hours)) {
                     if (isPM && hours < 12) hours += 12;
                     if (isAM && hours === 12) hours = 0;
                 } else {
                     hours = 23;
                 }
                 jobDateTime.setHours(hours, minutes, 0, 0);
              } else {
                 jobDateTime.setHours(23, 59, 59, 0);
              }
              
              if (jobDateTime < now && !isNaN(jobDateTime.getTime())) {
                 a.applicationStatus = "completed"; 
                 a.status = "completed";
              }
           } catch(e) {}
        }
      }
    });

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
      
      const FlatActionNeeded = payloadMap.action ? Object.values(payloadMap.action).flat() : [];
      const profSubs = [...new Set(FlatActionNeeded.map((a: any) => a.professionalUserSub).filter(Boolean))];
      const profilesMap = new Map();

      const PROF_TBL = process.env.PROFESSIONAL_PROFILES_TABLE || process.env.PROFILES_TABLE;
      if (PROF_TBL && profSubs.length > 0) {
        const { BatchGetItemCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
        const { unmarshall } = require("@aws-sdk/util-dynamodb");
        for (let i = 0; i < profSubs.length; i += 100) {
          const chunk = profSubs.slice(i, i + 100);
          try {
            const resp: any = await dynamodb.send(new BatchGetItemCommand({ RequestItems: { [PROF_TBL]: { Keys: chunk.map((s: any) => ({ userSub: { S: s } })) } } }));
            const arr = resp.Responses?.[PROF_TBL] || [];
            arr.forEach((item: any) => {
              const p = unmarshall(item);
              profilesMap.set(p.userSub, p);
            });
          } catch(e) { console.error("Profile fetch error", e); }
        }

        // Add negotiation fetching
        for(const app of FlatActionNeeded as any[]) {
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
      
      finalData = payloadMap.action;
    } else if (path.includes("scheduled-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: scheduled-shifts. Serving groupedScheduled.");
      finalData = payloadMap.scheduled;
    } else if (path.includes("completed-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: completed-shifts. Serving groupedCompleted.");
      finalData = payloadMap.completed;
    } else if (path.includes("invites-shifts")) {
      console.log("[getAllClinicsShifts] Dynamic Route matched: invites-shifts. Serving groupedInvites.");
      
      if (process.env.JOB_INVITATIONS_TABLE && clinicIds.length > 0) {
        const { ScanCommand } = require("@aws-sdk/client-dynamodb");
        let inviteItems: any[] = [];
        let lastKey;
        do {
          const res: any = await dynamodb.send(new ScanCommand({
            TableName: process.env.JOB_INVITATIONS_TABLE,
            ExclusiveStartKey: lastKey
          }));
          if (res.Items) inviteItems.push(...res.Items);
          lastKey = res.LastEvaluatedKey;
        } while (lastKey);

        const clinicIdSet = new Set(clinicIds);
        const filteredInvites = inviteItems.filter(item =>
          clinicIdSet.has(s(item.clinicId)) && s(item.invitationStatus) !== "accepted"
        );
        
        const profSubs = [...new Set(filteredInvites.map(item => s(item.professionalUserSub)).filter(Boolean))];
        const profilesMap = new Map();

        const PROF_TBL = process.env.PROFESSIONAL_PROFILES_TABLE || process.env.PROFILES_TABLE;
        if (PROF_TBL && profSubs.length > 0) {
          const { BatchGetItemCommand } = require("@aws-sdk/client-dynamodb");
          const { unmarshall } = require("@aws-sdk/util-dynamodb");
          for (let i = 0; i < profSubs.length; i += 100) {
            const chunk = profSubs.slice(i, i + 100);
            try {
              const resp: any = await dynamodb.send(new BatchGetItemCommand({ RequestItems: { [PROF_TBL]: { Keys: chunk.map((subStr: any) => ({ userSub: { S: subStr } })) } } }));
              const arr = resp.Responses?.[PROF_TBL] || [];
              arr.forEach((item: any) => {
                const p = unmarshall(item);
                profilesMap.set(p.userSub, p);
              });
            } catch(e) { console.error("Profile fetch error", e); }
          }
        }

        filteredInvites.forEach(item => {
          const cid = s(item.clinicId);
          const jobId = s(item.jobId);
          const job = jobMap.get(jobId) || {};
          const profSub = s(item.professionalUserSub);
          
          const profile = profilesMap.get(profSub);
          const first_name = profile?.first_name || '';
          const last_name = profile?.last_name || '';
          const fullName = profile ? `${first_name} ${last_name}`.trim() : "Professional";
          
          const enriched = {
            ...job, // Bring in all job properties
            
            invitationId: s(item.invitationId),
            jobId: jobId,
            clinicId: cid,
            professionalUserSub: profSub,
            professionalName: fullName,
            first_name,
            last_name,
            invitationStatus: s(item.invitationStatus) || "pending",
            applicationStatus: s(item.invitationStatus) || "pending",
            sentAt: s(item.sentAt),
            appliedAt: s(item.sentAt),
            updatedAt: s(item.updatedAt),
            message: s(item.message),
            rateOffered: n(item.rateOffered),
            
            jobTitle: job.jobTitle || "No Title",
            rate: job.rate || null,
            payType: job.payType || "per_hour",
          };
          if (!groupedInvites[cid]) groupedInvites[cid] = [];
          groupedInvites[cid].push(enriched);
        });
      }
      
      finalData = groupedInvites;
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