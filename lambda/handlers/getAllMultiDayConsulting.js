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

// --- helper: get all jobIds this professional has applied to ---
async function getAppliedJobIdsForUser(userSub) {
  const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
  const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

  const ids = new Set();
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
    (resp.Items || []).forEach(it => it.jobId?.S && ids.add(it.jobId.S));
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return ids;
}

const handler = async (event) => {
  try {
    const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    // ✅ Validate token and get the actual user sub
    const userSub = await validateToken(event);

    // Get all multi-day consulting jobs
    const jobsCommand = new ScanCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      FilterExpression: "job_type = :jobType",
      ExpressionAttributeValues: {
        ":jobType": { S: "multi_day_consulting" }
      }
    });
    const jobResponse = await dynamodb.send(jobsCommand);
    const items = jobResponse.Items || [];

    if (items.length === 0) {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({
          message: "Multi-day consulting jobs retrieved successfully",
          excludedCount: 0,
          jobs: []
        }),
      };
    }

    // 🚫 Exclude jobs already applied by this professional
    const appliedJobIds = await getAppliedJobIdsForUser(userSub);
    const visibleItems = items.filter(it => !appliedJobIds.has(it.jobId?.S));
// Normalize a DynamoDB attribute into string[]
function toStrArr(attr) {
  if (!attr) return [];
  if (Array.isArray(attr.SS)) return attr.SS;                 // String Set
  if (Array.isArray(attr.L)) {                                // List of {S: "..."}
    return attr.L.map(v => (v && typeof v.S === "string" ? v.S : null))
                 .filter(Boolean);
  }
  if (typeof attr.S === "string") return [attr.S];            // single string
  return [];
}

    // Map the visible items (your original mapping)
    const jobs = visibleItems.map(job => {
      return {
        jobId: job.jobId?.S || '',
        jobType: job.job_type?.S || '',
        clinicUserSub: job.clinicUserSub?.S || '',
        clinicId: job.clinicId?.S || '',
        professionalRole: job.professional_role?.S || '',
        jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Consulting Position`,
        description: job.job_description?.S || '',
        requirements: job.requirements?.SS || [],
        dates: toStrArr(job.dates),
        startTime: job.start_time?.S || '',
        endTime: job.end_time?.S || '',
        SoftwareRequired: job.clinicSoftware?.S || "",
        hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0,
        totalDays: toStrArr(job.dates).length,
        mealBreak: job.meal_break?.S || job.meal_break?.BOOL || null,
        shiftSpeciality: job.shift_speciality?.S || "",
        freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
        parkingType: job.parkingType?.S || '',
        parkingRate: job.parking_rate?.N ? parseFloat(job.parking_rate.N) : 0,
        location: {
          addressLine1: job.addressLine1?.S || '',
          addressLine2: job.addressLine2?.S || '',
          addressLine3: job.addressLine3?.S || '',
          city: job.city?.S || '',
          state: job.state?.S || '',
          zipCode: job.pincode?.S || ''
        },
        contactInfo: {
          email: job.contact_email?.S || '',
          phone: job.contact_phone?.S || ''
        },
        specialRequirements: job.special_requirements?.SS || [],
        projectScope: job.project_scope?.S || '',
        consultingType: job.consulting_type?.S || '',
        expectedOutcome: job.expected_outcome?.S || '',
        status: job.status?.S || 'active',
        createdAt: job.created_at?.S || '',
        updatedAt: job.updated_at?.S || '',
      };
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        message: "Multi-day consulting jobs retrieved successfully",
        excludedCount: appliedJobIds.size,  // helpful for verifying exclusion
        jobs
      }),
    };
  } catch (error) {
    console.error("Error retrieving multi-day consulting jobs:", error);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: "Failed to retrieve multi-day consulting jobs. Please try again.",
        details: error?.message || String(error)
      }),
    };
  }
};

exports.handler = handler;
