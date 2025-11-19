/* eslint-disable @typescript-eslint/no-explicit-any */
"use strict";

import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils";

export const dynamodb = new DynamoDBClient({
  region: process.env.REGION,
});

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

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

// ---- MAIN LAMBDA HANDLER ----
export const handler = async (event: any) => {
  try {
    // Handle OPTIONS
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    const userSub = await validateToken(event);
    const queryParams = event.queryStringParameters || {};

    const status = queryParams.status;
    const jobType = queryParams.jobType;
    const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;

    // ---- Scan Applications Table ----
    const applicationsCommand = new ScanCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      FilterExpression:
        "professionalUserSub = :userSub" +
        (status ? " AND applicationStatus = :status" : ""),
      ExpressionAttributeValues: {
        ":userSub": { S: userSub },
        ...(status && { ":status": { S: status } }),
      },
      Limit: limit,
    });

    const applicationsResponse = await dynamodb.send(applicationsCommand);
    const applications: any[] = [];

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
            IndexName: "jobId-index",
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
            application.hourlyRate = num(job.hourly_rate) ?? 0;
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
            application.payType = str(job.work_schedule);
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
          }
        } catch (jobError: any) {
          console.warn(
            `Failed to fetch job details for ${application.jobId}:`,
            jobError
          );
        }

        // ---- Negotiation Flow ----
        const isNegotiating =
          (application.applicationStatus || "").toLowerCase() ===
          "negotiating";

        if (isNegotiating && application.applicationId) {
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
                  "applicationId, negotiationId, clinicCounterHourlyRate, professionalCounterHourlyRate, negotiationStatus, updatedAt, createdAt",
              })
            );

            const latest = pickLatestNegotiation(negoResp.Items || []);

            if (latest) {
              application.negotiation = {
                negotiationId: str(latest.negotiationId),
                clinicCounterHourlyRate:
                  num(latest.clinicCounterHourlyRate) ?? null,
                professionalCounterHourlyRate:
                  num(latest.professionalCounterHourlyRate) ?? null,
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

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Job applications retrieved successfully",
        applications,
        totalCount: applications.length,
        filters: {
          status: status || "all",
          jobType: jobType || "all",
          limit,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error retrieving job applications:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to retrieve job applications. Please try again.",
        details: error.message,
      }),
    };
  }
};
