/* eslint-disable @typescript-eslint/no-explicit-any */
"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandOutput,
  GetItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
export const dynamodb = new DynamoDBClient({
  region: process.env.REGION,
});

const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-V5-ClinicProfiles";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-V5-Clinics";

/** Per-invocation cache. Keys: clinicUserSub for profile-table hits,
 *  "cid:<clinicId>" for clinics-table hits. Avoids redundant GetItems
 *  when multiple applications share a clinic. */
async function fetchClinicName(
  clinicUserSub: string,
  clinicId: string,
  cache: Map<string, string>
): Promise<string | undefined> {
  // 1) Preferred: ClinicProfiles keyed by userSub.
  if (clinicUserSub) {
    if (cache.has(clinicUserSub)) return cache.get(clinicUserSub);
    try {
      const resp = await dynamodb.send(new GetItemCommand({
        TableName: CLINIC_PROFILES_TABLE,
        Key: { userSub: { S: clinicUserSub } },
        ProjectionExpression: "clinic_name",
      }));
      const name = resp.Item?.clinic_name?.S || "";
      if (name) {
        cache.set(clinicUserSub, name);
        if (clinicId) cache.set(`cid:${clinicId}`, name);
        return name;
      }
    } catch (e) {
      console.warn(`[getJobApplications] profile lookup failed for sub=${clinicUserSub}:`, e);
    }
  }

  // 2) Fallback: Clinics table keyed by clinicId. Covers legacy/test rows
  //    where clinicUserSub is empty on both the application and job rows.
  if (clinicId) {
    const cidKey = `cid:${clinicId}`;
    if (cache.has(cidKey)) return cache.get(cidKey);
    try {
      const resp = await dynamodb.send(new GetItemCommand({
        TableName: CLINICS_TABLE,
        Key: { clinicId: { S: clinicId } },
        ProjectionExpression: "#n",
        ExpressionAttributeNames: { "#n": "name" },
      }));
      const name = resp.Item?.name?.S || "";
      if (name) {
        cache.set(cidKey, name);
        return name;
      }
    } catch (e) {
      console.warn(`[getJobApplications] clinics lookup failed for clinicId=${clinicId}:`, e);
    }
  }

  return undefined;
}


// -------- Helper: Pick Latest Negotiation --------
function pickLatestNegotiation(items: Record<string, AttributeValue>[]) {
  if (!items || !items.length) return null;

  const score = (it: any) => {
    const tryNum = (v: string) => {
      const n = Number(v);
      if (!Number.isNaN(n) && n > 0 && String(n).length >= 10) return n;
      const d = Date.parse(v);
      return Number.isNaN(d) ? -Infinity : d;
    };

    const u = it.updatedAt?.S;
    const c = it.createdAt?.S;

    if (u) return tryNum(u);
    if (c) return tryNum(c);
    return -Infinity;
  };

  let best = items[0];
  let bestScore = score(items[0]);

  for (let i = 1; i < items.length; i++) {
    const s = score(items[i]);
    if (s > bestScore) {
      best = items[i];
      bestScore = s;
    }
  }

  return best;
}

// --- Helpers to clean DynamoDB attributes ---
const num = (x: AttributeValue | undefined): number | undefined =>
  x && "N" in x ? parseFloat(x.N as string) : undefined;

const bool = (x: AttributeValue | undefined): boolean | undefined => {
  if (x && "BOOL" in x) return x.BOOL as boolean;
  if (x && "S" in x) {
    const v = (x.S as string)?.toLowerCase();
    if (v === "true") return true;
    if (v === "false") return false;
  }
  return undefined;
};

const str = (x: AttributeValue | undefined): string =>
  x && "S" in x ? (x.S as string) : "";

const strOr = (a?: AttributeValue, b?: AttributeValue): string =>
  (a && "S" in a && a.S) || (b && "S" in b && b.S) || "";

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): any => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

// ---- MAIN LAMBDA HANDLER ----
export const handler = async (event: any) => {
  try {
    // Handle OPTIONS
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    let userSub: string;
    try {
      const authHeader = event.headers?.Authorization || event.headers?.authorization;
      const userInfo = extractUserFromBearerToken(authHeader);
      userSub = userInfo.sub;
    } catch (authError: any) {
      return { statusCode: 401, headers: corsHeaders(event), body: JSON.stringify({ error: authError.message || "Invalid access token" }) };
    }
    const queryParams = event.queryStringParameters || {};

    const status = queryParams.status;
    const jobType = queryParams.jobType;

    // ---- Query Applications via professionalUserSub-index GSI ----
    //
    // Previously this was a Scan with Limit:50 + FilterExpression — DynamoDB
    // applies Limit BEFORE the filter, so on any non-trivial table that
    // returned a near-empty result and randomly hid the user's rows. Switched
    // to a Query against the GSI (PK=professionalUserSub) which only reads
    // this user's rows, paginating to completion so we never drop a row.
    // No artificial cap: every professional's applications must be returned
    // so the dashboard's tabs (scheduled / completed / pending) are accurate.
    const allItems: Record<string, AttributeValue>[] = [];
    let exclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;
    do {
      const out: QueryCommandOutput = await dynamodb.send(new QueryCommand({
        TableName: process.env.JOB_APPLICATIONS_TABLE,
        IndexName: "professionalUserSub-index",
        KeyConditionExpression: "professionalUserSub = :userSub",
        ...(status
          ? {
              FilterExpression: "applicationStatus = :status",
              ExpressionAttributeValues: {
                ":userSub": { S: userSub },
                ":status": { S: status },
              },
            }
          : {
              ExpressionAttributeValues: { ":userSub": { S: userSub } },
            }),
        ExclusiveStartKey: exclusiveStartKey,
      }));
      if (out.Items) allItems.push(...out.Items);
      exclusiveStartKey = out.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const applicationsResponse = { Items: allItems };
    const applications: any[] = [];
    const clinicNameCache = new Map<string, string>();

    const toDates = (attr: AttributeValue | undefined): string[] => {
      if (!attr) return [];
      if ("SS" in attr && Array.isArray(attr.SS)) return attr.SS;
      if ("L" in attr && Array.isArray(attr.L))
        return attr.L.map((v: any) => v?.S).filter(Boolean);
      if ("S" in attr && typeof attr.S === "string") return [attr.S];
      return [];
    };

    // ---- Iterate Applications ----
    if (applicationsResponse.Items) {
      for (const item of applicationsResponse.Items) {
        const application: any = {
          applicationId: str(item.applicationId),
          jobId: str(item.jobId),
          clinicId: str(item.clinicId),
          clinicUserSub: str(item.clinicUserSub),
          professionalUserSub: str(item.professionalUserSub),
          applicationStatus: str(item.applicationStatus) || "pending",
          appliedAt: str(item.appliedAt),
          updatedAt: str(item.updatedAt),
          applicationMessage: str(item.applicationMessage),
          proposedRate: num(item.proposedRate) ?? 0,
          proposedHourlyRate: num(item.proposedHourlyRate) ?? 0,
          availability: str(item.availability),
          notes: str(item.notes),
          acceptedRate: num(item.acceptedRate),
        };

        // ----- Fetch Job Details -----
        try {
          const jobCommand = new QueryCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            IndexName: "jobId-index-1",
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
              ":jobId": { S: application.jobId },
            },
          });

          const jobResponse = await dynamodb.send(jobCommand);

          if (jobResponse.Items?.[0]) {
            const job = jobResponse.Items[0];

            application.jobTitle =
              str(job.job_title) ||
              `${str(job.professional_role) || "Professional"} Position`;

            application.jobType = str(job.job_type);
            application.professionalRole = str(job.professional_role);
            application.description = str(job.job_description);
            application.shiftSpeciality = str(job.shift_speciality);
            application.requirements = job.requirements?.SS || [];
            application.date = str(job.date);
            application.dates = toDates(job.dates);
            application.startTime = str(job.start_time);
            application.endTime = str(job.end_time);
            application.rate = job.rate?.N ? parseFloat(job.rate.N) : (job.pay_type?.S === "per_transaction" ? (job.rate_per_transaction?.N ? parseFloat(job.rate_per_transaction.N) : 0) : job.pay_type?.S === "percentage_of_revenue" ? (job.revenue_percentage?.N ? parseFloat(job.revenue_percentage.N) : 0) : (num(job.hourly_rate) ?? 0));
            application.payType = str(job.pay_type) || "per_hour";
            application.mealBreak =
              str(job.meal_break) || (bool(job.meal_break) ?? null);
            application.freeParkingAvailable =
              bool(job.freeParkingAvailable) ?? false;
            application.parkingType = str(job.parkingType);
            application.parkingRate = num(job.parking_rate) ?? 0;
            application.softwareRequired = str(job.clinicSoftware);
            application.hoursPerDay = num(job.hours_per_day) ?? 0;
            application.hours = num(job.hours) ?? 0;
            application.jobBenefits = job.benefits?.SS || [];
            application.jobSalaryMin = num(job.salary_min) ?? null;
            application.jobSalaryMax = num(job.salary_max) ?? null;

            application.location = {
              addressLine1: str(job.addressLine1),
              addressLine2: str(job.addressLine2),
              addressLine3: str(job.addressLine3),
              city: str(job.city),
              state: str(job.state),
              zipCode: str(job.pincode),
            };

            application.startDate = str(job.start_date);

            application.contactInfo = {
              email: str(job.contact_email),
              phone: str(job.contact_phone),
            };

            application.specialRequirements =
              job.special_requirements?.SS || [];

            application.status = str(job.status) || "active";

            application.createdAt = strOr(job.created_at, job.createdAt);
            application.updatedAt = strOr(job.updated_at, job.updatedAt);

            // Resolve clinic display name with a three-step fallback chain so
            // every row gets populated:
            //   1. ClinicProfiles by application.clinicUserSub (preferred)
            //   2. ClinicProfiles by job row's clinicUserSub (denormalized at post time)
            //   3. Clinics table by clinicId (handles legacy/test rows where both
            //      subs are empty — clinicId is always set on the application row).
            const clinicUserSubForLookup = application.clinicUserSub || str(job.clinicUserSub);
            const clinicIdForLookup = application.clinicId || str(job.clinicId);
            const clinicName = await fetchClinicName(clinicUserSubForLookup, clinicIdForLookup, clinicNameCache);
            if (clinicName) {
              application.clinicName = clinicName;
              application.clinic = { ...(application.clinic || {}), name: clinicName };
            }
          }
        } catch (jobError: any) {
          console.warn(
            `Failed to fetch job details for ${application.jobId}:`,
            jobError
          );
        }

        // ---- Negotiation Flow ----
        // Fetch the negotiation row whenever the application has one — not only
        // for "negotiating" status. Scheduled / accepted / completed apps still
        // need the negotiation's agreedRate / proposedRate so the professional
        // dashboard can display the negotiated rate instead of the original
        // posting rate.
        const negotiationIdFromApp = str(item.negotiationId);
        const hasNegotiation = !!negotiationIdFromApp;

        if (hasNegotiation && application.applicationId) {
          try {
            const negoResp = await dynamodb.send(
              new QueryCommand({
                TableName: process.env.JOB_NEGOTIATIONS_TABLE,
                IndexName: "applicationId-index",
                KeyConditionExpression: "applicationId = :aid",
                ExpressionAttributeValues: {
                  ":aid": { S: application.applicationId },
                },
                ProjectionExpression:
                  "applicationId, negotiationId, clinicCounterHourlyRate, professionalCounterHourlyRate, clinicCounterRate, professionalCounterRate, agreedHourlyRate, agreedRate, proposedHourlyRate, proposedRate, payType, negotiationStatus, updatedAt, createdAt",
              })
            );

            const latest = pickLatestNegotiation(negoResp.Items || []);

            if (latest) {
              const clinicCounter = num(latest.clinicCounterRate) ?? num(latest.clinicCounterHourlyRate) ?? null;
              const professionalCounter = num(latest.professionalCounterRate) ?? num(latest.professionalCounterHourlyRate) ?? null;
              const agreed = num(latest.agreedRate) ?? num(latest.agreedHourlyRate) ?? null;
              const proposed = num(latest.proposedRate) ?? num(latest.proposedHourlyRate) ?? null;

              application.negotiationId = str(latest.negotiationId) || negotiationIdFromApp;
              application.negotiation = {
                negotiationId: str(latest.negotiationId),
                clinicCounterRate: clinicCounter,
                professionalCounterRate: professionalCounter,
                agreedRate: agreed,
                proposedRate: proposed,
                // Legacy aliases
                clinicCounterHourlyRate: clinicCounter,
                professionalCounterHourlyRate: professionalCounter,
                agreedHourlyRate: agreed,
                proposedHourlyRate: proposed,
                payType: str(latest.payType) || undefined,
                negotiationStatus: str(latest.negotiationStatus),
                updatedAt: str(latest.updatedAt),
                createdAt: str(latest.createdAt),
              };
            }
          } catch (e) {
            console.warn(
              `Failed to fetch negotiation for applicationId=${application.applicationId}:`,
              e
            );
          }
        }

        // ---- Job Type Filtering ----
        if (!jobType || application.jobType === jobType) {
          applications.push(application);
        }
      }
    }

    // ---- Sort by most recent appliedAt ----
    applications.sort(
      (a, b) =>
        new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()
    );

    return json(event, 200, {
      status: "success",
      statusCode: 200,
      message: "Job applications retrieved successfully",
      data: {
        applications: applications,
        totalCount: applications.length,
        filters: {
          status: status || "all",
          jobType: jobType || "all",
        }
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("Error retrieving job applications:", error);
    return json(event, 500, {
      error: "Internal Server Error",
      statusCode: 500,
      message: "Failed to retrieve job applications",
      details: { reason: error.message },
      timestamp: new Date().toISOString()
    });
      
    
  }
};
