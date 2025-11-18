"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// --- helper: pick the latest negotiation by updatedAt/createdAt ---
function pickLatestNegotiation(items) {
  if (!items || !items.length) return null;
  const score = (it) => {
    // prefer updatedAt, fallback createdAt
    const u = it.updatedAt?.S;
    const c = it.createdAt?.S;
    const tryNum = (v) => {
      const n = Number(v);
      if (!Number.isNaN(n) && n > 0 && String(n).length >= 10) return n; // epoch sec/ms
      const d = Date.parse(v);
      return Number.isNaN(d) ? -Infinity : d;
    };
    if (u) return tryNum(u);
    if (c) return tryNum(c);
    return -Infinity;
  };
  let best = items[0], bestScore = score(items[0]);
  for (let i = 1; i < items.length; i++) {
    const s = score(items[i]);
    if (s > bestScore) { best = items[i]; bestScore = s; }
  }
  return best;
}

// Helpers
const num = (x) => (x?.N ? parseFloat(x.N) : undefined);
const bool = (x) =>
  typeof x?.BOOL === "boolean"
    ? x.BOOL
    : (x?.S?.toLowerCase?.() === "true" ? true : x?.S?.toLowerCase?.() === "false" ? false : undefined);
const str = (x) => x?.S || "";
const strOr = (...xs) => xs.find((v) => v?.S)?.S || "";

const handler = async (event) => {
  try {
    // Handle preflight request
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // Token validation
    const userSub = await validateToken(event);
    const queryParams = event.queryStringParameters || {};

    // Optional filters
    const status = queryParams.status; // "pending", "accepted", "declined", "negotiating"
    const jobType = queryParams.jobType; // "temporary", "multi_day_consulting", "permanent"
    const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;

    // Get job applications for the professional user
    const applicationsCommand = new ScanCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      FilterExpression:
        "professionalUserSub = :userSub" + (status ? " AND applicationStatus = :status" : ""),
      ExpressionAttributeValues: {
        ":userSub": { S: userSub },
        ...(status && { ":status": { S: status } }),
      },
      Limit: limit,
    });

    const applicationsResponse = await dynamodb.send(applicationsCommand);
    const applications = [];

    // Normalize DynamoDB "dates" -> string[]
    const toDates = (attr) =>
      Array.isArray(attr?.SS)
        ? attr.SS
        : Array.isArray(attr?.L)
        ? attr.L.map((v) => v?.S).filter(Boolean)
        : typeof attr?.S === "string"
        ? [attr.S]
        : [];

    if (applicationsResponse.Items) {
      for (const item of applicationsResponse.Items) {
        const application = {
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

        // ---- fetch job details (existing) ----
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
          if (jobResponse.Items && jobResponse.Items[0]) {
            const job = jobResponse.Items[0];

            application.jobTitle =
              str(job.job_title) || `${str(job.professional_role) || "Professional"} Position`;
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
            application.mealBreak = str(job.meal_break) || (bool(job.meal_break) ?? null);
            application.freeParkingAvailable = bool(job.freeParkingAvailable) ?? false;
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

            application.specialRequirements = job.special_requirements?.SS || [];
            application.status = str(job.status) || "active";
            application.createdAt = strOr(job.created_at, job.createdAt);
            application.updatedAt = strOr(job.updated_at, job.updatedAt);
          }
        } catch (jobError) {
          console.warn(`Failed to fetch job details for ${application.jobId}:`, jobError);
        }

        // ---- NEW: if negotiating, fetch negotiation info via applicationId-index ----
        const isNegotiating =
          (application.applicationStatus || "").toLowerCase() === "negotiating";

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
                // keep projection small; we only need these fields
                ProjectionExpression:
                  "applicationId, negotiationId, clinicCounterHourlyRate, professionalCounterHourlyRate, negotiationStatus, updatedAt, createdAt",
                // If your GSI has a RANGE (e.g., updatedAt), you could add:
                // ScanIndexForward: false, Limit: 1
              })
            );

            const items = negoResp.Items || [];
            const latest = pickLatestNegotiation(items);

            if (latest) {
              application.negotiation = {
                negotiationId: str(latest.negotiationId),
                clinicCounterHourlyRate: num(latest.clinicCounterHourlyRate) ?? null,
                professionalCounterHourlyRate: num(latest.professionalCounterHourlyRate) ?? null,
                negotiationStatus: str(latest.negotiationStatus),
                updatedAt: str(latest.updatedAt),
                createdAt: str(latest.createdAt),
                // NOTE: proposedRate is already on `application` from the applications table
              };
            }
          } catch (e) {
            console.warn(
              `Failed to fetch negotiation for applicationId=${application.applicationId}:`,
              e
            );
          }
        }

        // Apply job type filter if specified
        if (!jobType || application.jobType === jobType) {
          applications.push(application);
        }
      }
    }

    applications.sort(
      (a, b) => new Date(b.appliedAt).getTime() - new Date(a.appliedAt).getTime()
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
  } catch (error) {
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

exports.handler = handler;