"use strict";

import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  GetItemCommand,
  ScanCommandInput,
  QueryCommandInput,
  GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

/* AWS Client */
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

/* ===========================
   Helper Types
=========================== */
interface ProfessionalName {
  first_name: string;
  last_name: string;
}

interface InvitationItem {
  invitationId: string;
  jobId: string;
  clinicId: string;
  professionalUserSub: string;
  invitationStatus: string;
  sentAt: string;
  updatedAt: string;
  message?: string;
  rateOffered?: number;
  validUntil?: string;

  first_name?: string;
  last_name?: string;

  jobTitle?: string;
  jobType?: string;
  jobLocation?: any;
  jobDescription?: string;
  jobHourlyRate?: number | null;
  jobSalaryMin?: number | null;
  jobSalaryMax?: number | null;
  dates?: string[];
  startdate?: string;
  startTime?: string;
  endTime?: string;
  date?: string;
  jobHours?: number | null;
  jobHoursPerDay?: number | null;
  jobEmploymentType?: string;
  jobBenefits?: string[];
  jobRequirements?: string[];
  jobMealBreak?: boolean;
  contactInfo?: any;
}

/* ===============================================
   Fetch first_name / last_name from profiles table
================================================= */
async function fetchProfessionalNameBySub(userSub: string): Promise<ProfessionalName> {
  try {
    if (!process.env.PROFESSIONAL_PROFILES_TABLE || !userSub) {
      return { first_name: "", last_name: "" };
    }

    const getParams: GetItemCommandInput = {
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      Key: { userSub: { S: userSub } },
      ProjectionExpression: "first_name, last_name",
    };

    const getRes = await dynamodb.send(new GetItemCommand(getParams));

    if (getRes.Item) {
      return {
        first_name: getRes.Item.first_name?.S ?? "",
        last_name: getRes.Item.last_name?.S ?? "",
      };
    }

    const qParams: QueryCommandInput = {
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      IndexName: "userSub-index",
      KeyConditionExpression: "userSub = :u",
      ExpressionAttributeValues: { ":u": { S: userSub } },
      ProjectionExpression: "first_name, last_name",
      Limit: 1,
    };

    const qRes = await dynamodb.send(new QueryCommand(qParams));
    const item = qRes.Items?.[0];

    if (item) {
      return {
        first_name: item.first_name?.S ?? "",
        last_name: item.last_name?.S ?? "",
      };
    }
  } catch (e) {
    console.warn("Name lookup failed:", e);
  }

  return { first_name: "", last_name: "" };
}

/* ===============================================
   MAIN HANDLER — FULL TYPE-SAFE
================================================= */
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // CORS Preflight
    if (event?.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: "",
      };
    }

    console.log("JOB_INVITATIONS_TABLE:", process.env.JOB_INVITATIONS_TABLE);
    console.log("JOB_POSTINGS_TABLE:", process.env.JOB_POSTINGS_TABLE);
    console.log("PROFESSIONAL_PROFILES_TABLE:", process.env.PROFESSIONAL_PROFILES_TABLE);

    if (!process.env.JOB_INVITATIONS_TABLE || !process.env.JOB_POSTINGS_TABLE) {
      return json(500, {
        error: "Table names are missing from the environment variables",
      });
    }

    // --- FIX: Add Validation Here ---
    await validateToken(event);

    const fullPath = event.pathParameters?.proxy;
    const clinicId = fullPath ? fullPath.split("/")[1] : null;

    console.log("Extracted clinicId:", clinicId);

    if (!clinicId) {
      return json(400, { error: "clinicId is required in the path" });
    }

    const queryParams = event.queryStringParameters ?? {};
    const invitationStatus = queryParams.status;
    const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;

    const scanParams: ScanCommandInput = {
      TableName: process.env.JOB_INVITATIONS_TABLE,
      FilterExpression:
        "clinicId = :clinicId" +
        (invitationStatus ? " AND invitationStatus = :status" : ""),
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId },
        ...(invitationStatus && { ":status": { S: invitationStatus } }),
      },
      Limit: limit,
    };

    console.log("ScanParams:", scanParams);

    const scanResponse = await dynamodb.send(new ScanCommand(scanParams));
    console.log("Scan response:", scanResponse);

    const invitations: InvitationItem[] = [];

    if (scanResponse.Items) {
      for (const item of scanResponse.Items) {
        const invitation: InvitationItem = {
          invitationId: item.invitationId?.S || "",
          jobId: item.jobId?.S || "",
          clinicId: item.clinicId?.S || "",
          professionalUserSub: item.professionalUserSub?.S || "",
          invitationStatus: item.invitationStatus?.S || "pending",
          sentAt: item.sentAt?.S || "",
          updatedAt: item.updatedAt?.S || "",
        };

        if (item.message?.S) invitation.message = item.message.S;
        if (item.rateOffered?.N) invitation.rateOffered = parseFloat(item.rateOffered.N);
        if (item.validUntil?.S) invitation.validUntil = item.validUntil.S;

        try {
          const name = await fetchProfessionalNameBySub(invitation.professionalUserSub);
          invitation.first_name = name.first_name;
          invitation.last_name = name.last_name;
        } catch (err) {
          console.warn("Name fetch failed:", err);
        }

        try {
          const jobQuery: QueryCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE!,
            IndexName: "jobId-index",
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: { ":jobId": { S: invitation.jobId } },
          };

          const jobResponse = await dynamodb.send(new QueryCommand(jobQuery));

          if (jobResponse.Items && jobResponse.Items[0]) {
            const job = jobResponse.Items[0];

            invitation.jobTitle = job.professional_role?.S || "Unknown Job Title";
            invitation.jobType = job.job_type?.S || "Unknown";
            invitation.jobLocation = job.job_location?.S || "Unknown Location";
            invitation.jobDescription = job.job_description?.S || "No description available";
            invitation.jobHourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : null;
            invitation.jobSalaryMin = job.salary_min?.N ? parseFloat(job.salary_min.N) : null;
            invitation.jobSalaryMax = job.salary_max?.N ? parseFloat(job.salary_max.N) : null;
            invitation.dates = job.dates?.SS || [];
            invitation.startdate = job.start_date?.S || "";
            invitation.startTime = job.start_time?.S || "";
            invitation.endTime = job.end_time?.S || "";
            invitation.date = job.date?.S || "";
            invitation.jobHours = job.hours?.N ? parseFloat(job.hours.N) : null;
            invitation.jobHoursPerDay = job.hours_per_day?.N
              ? parseFloat(job.hours_per_day.N)
              : null;
            invitation.jobEmploymentType =
              job.employment_type?.S || "Unknown Employment Type";
            invitation.jobBenefits = job.benefits?.SS || [];
            invitation.jobRequirements = job.requirements?.SS || [];
            invitation.jobMealBreak = job.meal_break?.BOOL ?? false;

            invitation.jobLocation = {
              addressLine1: job.addressLine1?.S || "",
              addressLine2: job.addressLine2?.S || "",
              addressLine3: job.addressLine3?.S || "",
              city: job.city?.S || "",
              state: job.state?.S || "",
              zipCode: job.pincode?.S || "",
            };

            invitation.contactInfo = {
              email: job.contact_email?.S || "",
              phone: job.contact_phone?.S || "",
            };
          }
        } catch (jobError) {
          console.warn("Failed to fetch job details:", jobError);
        }

        invitations.push(invitation);
      }
    }

    invitations.sort(
      (a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime()
    );

    return json(200, {
      message: "Invitations fetched successfully.",
      invitations,
      totalCount: invitations.length,
      filters: {
        status: invitationStatus || "all",
        limit,
      },
    });

  } catch (error: any) {
    console.error("Error fetching invitations:", error);
    return json(500, {
      error: "Failed to retrieve invitations.",
      details: error?.message,
    });
  }
};