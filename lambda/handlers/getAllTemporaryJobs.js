"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

// Utility: today in UTC "YYYY-MM-DD"
function utcToday() {
  const iso = new Date().toISOString();
  return iso.slice(0, 10);
}

// ---- NEW: query applied jobIds for this professional via GSI ----
async function getAppliedJobIdsForUser(userSub) {
  const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
  const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

  const set = new Set();
  let ExclusiveStartKey;
  do {
    const resp = await dynamodb.send(new QueryCommand({
      TableName: table,
      IndexName: index,
      KeyConditionExpression: "professionalUserSub = :sub",
      ProjectionExpression: "jobId",
      ExpressionAttributeValues: { ":sub": { S: userSub } },
      ExclusiveStartKey,
    }));
    (resp.Items || []).forEach(it => it.jobId?.S && set.add(it.jobId.S));
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return set;
}

const handler = async (event) => {
  const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

  try {
    // Logged-in professional
    const userSub = await validateToken(event);
    const today = utcToday();

    // Scan upcoming temporary jobs
    const baseParams = {
      TableName: process.env.JOB_POSTINGS_TABLE,
      FilterExpression: `
        job_type = :jobType AND (
          #date >= :today
        )
      `,
      ExpressionAttributeNames: { "#date": "date" },
      ExpressionAttributeValues: {
        ":jobType": { S: "temporary" },
        ":today": { S: today },
      },
    };

    const items = [];
    let ExclusiveStartKey;
    do {
      const cmd = new ScanCommand({ ...baseParams, ExclusiveStartKey });
      const resp = await dynamodb.send(cmd);
      if (resp.Items) items.push(...resp.Items);
      ExclusiveStartKey = resp.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // ---- NEW: get applied jobIds for this professional and exclude them ----
    const appliedJobIds = await getAppliedJobIdsForUser(userSub);
    const visibleItems = (items || []).filter(it => !appliedJobIds.has(it.jobId?.S));

    // Helpers
    const num = (x) => (x?.N ? parseFloat(x.N) : undefined);
    const bool = (x) =>
      typeof x?.BOOL === "boolean"
        ? x.BOOL
        : (x?.S?.toLowerCase?.() === "true" ? true : x?.S?.toLowerCase?.() === "false" ? false : undefined);
    const str = (x) => x?.S || "";
    const strOr = (...xs) => xs.find((v) => v?.S)?.S || "";

    // Map only visible items
    const jobs = (visibleItems || []).map((job) => ({
      jobId: str(job.jobId),
      jobType: str(job.job_type),
      clinicUserSub: str(job.clinicUserSub),
      clinicId: str(job.clinicId),
      professionalRole: str(job.professional_role),
      shiftSpeciality: str(job.shift_speciality),
      jobTitle: str(job.job_title) || (job.professional_role?.S ? `${job.professional_role.S} Position` : "Position"),
      requirements: job.requirements?.SS || [],
      date: str(job.date),
      description: str(job.job_description),
      startTime: str(job.start_time),
      endTime: str(job.end_time),
      hourlyRate: num(job.hourly_rate) ?? 0,
      mealBreak: str(job.meal_break) || (bool(job.meal_break) ?? null),
      freeParkingAvailable: bool(job.freeParkingAvailable) ?? false,
      parkingType: str(job.parkingType),
      parkingRate: num(job.parking_rate) ?? 0,
      softwareRequired: str(job.clinicSoftware),
      location: {
        addressLine1: str(job.addressLine1),
        addressLine2: str(job.addressLine2),
        addressLine3: str(job.addressLine3),
        city: str(job.city),
        state: str(job.state),
        zipCode: str(job.pincode),
      },
  
      contactInfo: {
        email: str(job.contact_email),
        phone: str(job.contact_phone),
      },
      specialRequirements: job.special_requirements?.SS || [],
      status: str(job.status) || "active",
      createdAt: strOr(job.created_at, job.createdAt),
      updatedAt: strOr(job.updated_at, job.updatedAt),
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        message: "Temporary jobs (today or in the future) retrieved successfully",
        excludedCount: appliedJobIds.size, // helpful for debugging
        count: jobs.length,
        jobs,
      }),
    };
  } catch (error) {
    console.error("Error retrieving temporary jobs:", error);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: "Failed to retrieve temporary jobs. Please try again.",
        details: error?.message || String(error),
      }),
    };
  }
};

exports.handler = handler;
