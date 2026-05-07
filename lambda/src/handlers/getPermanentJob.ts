import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandInput,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";

import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // Handle HTTP API (v2) structure where method is in requestContext.http
  const method = event.httpMethod || (event.requestContext as any)?.http?.method;

  // CORS Preflight
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    // Extract Bearer token from Authorization header
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;

    const pathParts = event.pathParameters?.proxy?.split("/");
    const jobId = pathParts?.[2];

    if (!jobId) {
      return json(event, 400, {
        error: "jobId is required in path parameters",
      });
    }

    const jobCommand: GetItemCommandInput = {
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        jobId: { S: jobId },
      },
    };

    const jobResponse = await dynamodb.send(new GetItemCommand(jobCommand));

    if (!jobResponse.Item) {
      return json(event, 404, {
        error: "Permanent job not found or access denied",
      });
    }

    const job = jobResponse.Item;

    if (job.job_type?.S !== "permanent") {
      return json(event, 400, {
        error: "This is not a permanent job. Use the appropriate endpoint for this job type.",
      });
    }

    let applicationCount = 0;
    try {
      const applicationsResponse = await dynamodb.send(new QueryCommand({
        TableName: process.env.JOB_APPLICATIONS_TABLE,
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: { ":jobId": { S: jobId } },
        Select: "COUNT",
      }));
      applicationCount = applicationsResponse.Count || 0;
    } catch (err) {
      console.warn("Failed to get application count:", err);
    }

    const permanentJob = {
      jobId: job.jobId?.S || "",
      jobType: job.job_type?.S || "",
      professionalRole: job.professional_role?.S || "",
      professionalRoles: job.professional_roles?.SS
        || (job.professional_role?.S ? [job.professional_role.S] : []),
      shiftSpeciality: job.shift_speciality?.S || "",
      workLocationType: job.work_location_type?.S || "onsite",
      jobTitle: job.job_title?.S || "",
      jobDescription: job.job_description?.S || "",
      requirements: job.requirements?.SS || [],
      employmentType: job.employment_type?.S || "",
      salaryMin: job.salary_min?.N ? parseFloat(job.salary_min.N) : 0,
      salaryMax: job.salary_max?.N ? parseFloat(job.salary_max.N) : 0,
      benefits: job.benefits?.SS || [],
      vacationDays: job.vacation_days?.N ? parseInt(job.vacation_days.N, 10) : 0,
      workSchedule: job.work_schedule?.S || "",
      startDate: job.start_date?.S || "",
      status: job.status?.S || "active",

      addressLine1: job.addressLine1?.S || "",
      addressLine2: job.addressLine2?.S || "",
      addressLine3: job.addressLine3?.S || "",
      fullAddress: `${job.addressLine1?.S || ""} ${job.addressLine2?.S || ""} ${job.addressLine3?.S || ""}`,

      city: job.city?.S || "",
      state: job.state?.S || "",
      pincode: job.pincode?.S || "",

      bookingOutPeriod: job.bookingOutPeriod?.S || "immediate",
      clinicSoftware: job.clinicSoftware?.S || "Unknown",
      freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
      parkingType: job.parkingType?.S || "N/A",
      practiceType: job.practiceType?.S || "General",
      primaryPracticeArea: job.primaryPracticeArea?.S || "General Dentistry",

      createdAt: job.createdAt?.S || "",
      updatedAt: job.updatedAt?.S || "",
      created_by: job.created_by?.S || "",
      applicationCount,
      applicationsEnabled: job.status?.S === "active" || job.status?.S === "open",
    };

    return json(event, 200, {
      message: "Permanent job retrieved successfully",
      job: permanentJob,
    });

  } catch (error: any) {
    console.error("Error retrieving permanent job:", error);

    return json(event, 500, {
      error: "Failed to retrieve permanent job. Please try again.",
      details: error.message,
    });
  }
};