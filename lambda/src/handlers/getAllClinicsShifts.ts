"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  BatchGetItemCommand,
  QueryCommandInput,
  QueryCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { CognitoIdentityProviderClient, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, listAccessibleClinicIds } from "./utils";
import { corsHeaders } from "./corsHeaders";
import {
  getProfessionalAvailability,
  getScheduledOccurrences,
  jobBlockedByAvailability,
} from "./professionalAvailability";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
const USER_POOL_ID = process.env.USER_POOL_ID || "";

const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE;
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE;
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE;

// Optional envs (defaults provided)
const JOB_APPLICATIONS_CLINIC_GSI =
  process.env.JOB_APPLICATIONS_CLINIC_GSI || "clinicId-jobId-index";
const JOB_POSTINGS_CLINIC_GSI = process.env.JOB_POSTINGS_CLINIC_GSI || "ClinicIdIndex";

// --- Status Configurations ---

// 1. Scheduled: The job is filled/booked
const SCHEDULED_STATUSES = (process.env.SCHEDULED_STATUSES || "scheduled,accepted,booked")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 2. Completed: The job is done.
// `no_show` is a terminal "shift outcome" set by reportNoShow.ts when the
// clinic reports a no-show — surfaced in the Completed tab with a distinct
// badge on the frontend.
const COMPLETED_STATUSES = (process.env.COMPLETED_STATUSES || "completed,paid,no_show")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

// 3. Ignored: These don't require action and don't count as "open" or "filled".
// "filled" is included so a job whose only acceptance write succeeded but whose
// downstream auto-reject sweep failed cannot leak back into Open Shifts /
// Action Needed via leftover pending applications. Env override still wins.
const TERMINAL_IGNORE_STATUSES = (process.env.TERMINAL_IGNORE_STATUSES || "rejected,cancelled,declined,filled")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

/* ----------------------------- Helpers ----------------------------- */

const json = (event: any, statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
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
  try {
    if (event.httpMethod === "OPTIONS") {
      return json(event, 200, { message: "CORS preflight OK" });
    }

    if (!JOB_POSTINGS_TABLE || !JOB_APPLICATIONS_TABLE) {
      return json(event, 500, { error: "Missing DynamoDB table env vars" });
    }

    // 1. Authentication & Authorization
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const requesterSub = userInfo?.sub || "";
    const groups: string[] = Array.isArray(userInfo?.groups) ? userInfo.groups : [];
    console.log(`[getAllClinicsShifts] Executing data fetch for userSub: ${requesterSub}`);

    // Determine which clinics this user may read across.
    // Every user — including Root — is scoped to clinics they appear in
    // (Clinics.AssociatedUsers or createdBy). Same membership rule as canAccessClinic.
    const accessible = await listAccessibleClinicIds(requesterSub, groups);
    const targetClinicIds: string[] = accessible ?? [];
    console.log(`[getAllClinicsShifts] ${targetClinicIds.length} accessible clinics for user ${requesterSub}.`);

    if (targetClinicIds.length === 0) {
      return json(event, 200, {
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
      locationUrl: s(it.locationUrl) || s(it.location_url),
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

    // 3b. JobInvitations lookup — build the set of (jobId, professionalUserSub)
    //     pairs that exist in JobInvitations. Any application matching one of
    //     these pairs is invite-originated, regardless of whether the
    //     application row itself carries the `fromInvitation` flag (legacy and
    //     accept-branch rows historically didn't).
    const invitedPairs = new Set<string>();
    if (JOB_INVITATIONS_TABLE && applicationItems.length > 0) {
      const inviteKeys = applicationItems
        .filter((it) => s(it.jobId) && s(it.professionalUserSub))
        .map((it) => ({
          jobId: { S: s(it.jobId) },
          professionalUserSub: { S: s(it.professionalUserSub) },
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
          console.warn("[getAllClinicsShifts] fromInvitation lookup failed:", err?.message);
        }
      }
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

      // Three independent signals — any one means this row is invite-originated.
      const sub = s(it.professionalUserSub);
      const fromInvitationFlag = Boolean((it.fromInvitation as any)?.BOOL);
      const invitationDate = s(it.invitationResponseDate);
      const isFromInvitation =
        fromInvitationFlag || Boolean(invitationDate) || invitedPairs.has(`${jobId}|${sub}`);

      return {
        ...job, // Bring in all job properties

        // Application Details OVERRIDING
        applicationId: s(it.applicationId),
        clinicId: s(it.clinicId),
        jobId,
        professionalUserSub: sub,
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
        fromInvitation: isFromInvitation,
        invitationResponseDate: invitationDate || null,
      };
    });

    // 5. Categorize (Bucketing Logic)
    //
    // Note: legacy time-based recategorization (silently flipping past-due
    // 'scheduled' rows to 'completed' at read time) was removed when the
    // clinic-driven post-shift confirmation flow was introduced. Past-due
    // 'scheduled' rows now stay in Scheduled until a clinic explicitly calls
    // /jobs/{jobId}/confirm-completion or /jobs/{jobId}/no-show, which is the
    // single source of truth for the Completed / No-Show outcome. Mirrors the
    // change in getClinicShifts.ts.

    // A. Scheduled Jobs: Confirmed/Booked applications
    const scheduledJobs = appsEnriched.filter((a) =>
      SCHEDULED_STATUSES.includes(a.applicationStatus)
    );

    // B. Completed Jobs: Finished/Paid applications
    const completedJobs = appsEnriched.filter((a) =>
      COMPLETED_STATUSES.includes(a.applicationStatus)
    );

    // C. Action Needed: Pending applications (applied, negotiating, etc.)
    //
    // Defense-in-depth: drop applications whose PARENT job is in a terminal
    // state (e.g. "filled", "cancelled"). The auto-reject sweep in acceptProf
    // normally flips these to "rejected" individually, but this guard catches
    // legacy data written before the sweep existed and any sweep iteration
    // that failed silently. Without it, a "filled" job with 69 leftover
    // pending applications would surface as 69 Action Needed items forever.
    const actionNeededPreAvailability = appsEnriched.filter((a) => {
      const parentJobStatus = normalizeStatus((a as any).status);
      if (parentJobStatus && TERMINAL_IGNORE_STATUSES.includes(parentJobStatus)) return false;

      const st = a.applicationStatus;
      if (!st) return true;
      if (SCHEDULED_STATUSES.includes(st)) return false;
      if (COMPLETED_STATUSES.includes(st)) return false;
      if (TERMINAL_IGNORE_STATUSES.includes(st)) return false;
      return true;
    });

    // Availability filter: hide pros who have become unavailable for the job's
    // slot since they applied (master toggle OFF, removed the weekday, blocked
    // the date, narrowed the time window, or got booked elsewhere). The
    // underlying application row is left untouched — only the read-time view
    // hides it, so a pro who flips availability back ON re-appears here.
    //
    // Performance: dedupes pros so each unique sub gets exactly one availability
    // + scheduled lookup per request. Runs in parallel. On any per-pro lookup
    // failure we default to KEEPING the row visible (transient DDB hiccup
    // shouldn't accidentally hide the whole Action Needed bucket).
    const uniqueProSubs = [
      ...new Set(actionNeededPreAvailability.map((a: any) => a.professionalUserSub).filter(Boolean)),
    ] as string[];

    type AvailCache = { availability: any; scheduled: any[] } | null;
    const availabilityCache = new Map<string, AvailCache>();
    await Promise.all(uniqueProSubs.map(async (sub) => {
      try {
        const [availability, scheduled] = await Promise.all([
          getProfessionalAvailability(sub),
          getScheduledOccurrences(sub),
        ]);
        availabilityCache.set(sub, { availability, scheduled });
      } catch (err) {
        availabilityCache.set(sub, null);
        console.warn("[getAllClinicsShifts] availability lookup failed; keeping pro visible:", {
          sub,
          error: (err as Error).message,
        });
      }
    }));

    // Build a synthetic AV item from the flattened job fields the helpers need.
    // Mirrors the `buildSyntheticJob` pattern used elsewhere — the helpers only
    // read date/start_date/dates/start_time/end_time, so we don't need to
    // re-marshall every field on the enriched row.
    const jobToAvForAvailability = (job: any): Record<string, AttributeValue> => {
      const av: Record<string, AttributeValue> = {};
      if (job?.date) av.date = { S: String(job.date) };
      if (job?.start_date) av.start_date = { S: String(job.start_date) };
      if (Array.isArray(job?.dates) && job.dates.length > 0) av.dates = { SS: job.dates };
      if (job?.start_time) av.start_time = { S: String(job.start_time) };
      if (job?.end_time) av.end_time = { S: String(job.end_time) };
      return av;
    };

    const actionNeededJobs = actionNeededPreAvailability.filter((a: any) => {
      const cached = availabilityCache.get(a.professionalUserSub);
      // No sub on the row, or lookup failed — default to showing (don't hide
      // due to data gaps, that would silently empty the Action Needed bucket).
      if (!cached) return true;
      const jobAv = jobToAvForAvailability(a);
      // No date/time fields to check against — keep visible (legacy rows or
      // job types without slot info).
      if (Object.keys(jobAv).length === 0) return true;
      const blockedReason = jobBlockedByAvailability(jobAv, cached.availability, cached.scheduled);
      return blockedReason === null;
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
      headers: corsHeaders(event),
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
      headers: corsHeaders(event),
      body: JSON.stringify({
        message: "All clinics categorized shifts successfully retrieved.",
        data: finalData,
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving all clinic shifts:", error);
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: "Failed to retrieve shifts.", details: error.message }),
    };
  }
};