"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
  AttributeValue
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";
const dynamodb = new DynamoDBClient({ region: process.env.REGION });



export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  console.log("📥 Incoming Event:", JSON.stringify(event, null, 2));

  try {
    // ---------------- AUTH ----------------
    let userSub: string;
    try {
      userSub = await validateToken(event);
      console.log("✅ User authenticated. userSub:", userSub);
    } catch (authErr) {
      console.warn("🚫 Token validation failed:", authErr);
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Forbidden: invalid or missing authorization"
        })
      };
    }

    // ---------------- Extract clinicId from PATH ----------------
    const proxy = event.pathParameters?.proxy || "";
    const pathParts = proxy.split("/").filter((p) => p);

    let clinicId: string | undefined;

    const markerIdx = pathParts.findIndex(
      (p) =>
        p.toLowerCase() === "clinics" ||
        p.toLowerCase() === "clinictemporary"
    );

    if (markerIdx !== -1 && pathParts.length > markerIdx + 1) {
      clinicId = pathParts[markerIdx + 1];
    } else if (pathParts.length) {
      const last = pathParts[pathParts.length - 1];
      const uuidRegex = /^[0-9a-fA-F-]{36}$/;
      clinicId = uuidRegex.test(last) ? last : pathParts[0];
    }

    if (!clinicId && event.pathParameters?.clinicId) {
      clinicId = event.pathParameters.clinicId;
    }

    if (!clinicId && event.queryStringParameters?.clinicId) {
      clinicId = event.queryStringParameters.clinicId;
    }

    if (!clinicId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "clinicId is required in path or query string"
        })
      };
    }

    // ---------------- AUTHORIZATION CHECK ----------------
    const groupsRaw =
      event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";

    const groups = Array.isArray(groupsRaw)
      ? groupsRaw
      : groupsRaw
          .split(",")
          .map((g: string) => g.trim()) // FIXED ERROR HERE
          .filter(Boolean);

    const isRoot = groups.includes("Root");

    if (!isRoot) {
      const authProfileCommand = new GetItemCommand({
        TableName: process.env.CLINIC_PROFILES_TABLE as string,
        Key: {
          clinicId: { S: clinicId },
          userSub: { S: userSub }
        },
        ProjectionExpression: "clinicId, userSub"
      });

      const authProfileResp = await dynamodb.send(authProfileCommand);

      if (!authProfileResp.Item) {
        return {
          statusCode: 403,
          headers: CORS_HEADERS,
          body: JSON.stringify({
            error: "Unauthorized: no access to this clinic's jobs"
          })
        };
      }
    }

    // ---------------- QUERY JOBS ----------------
    const queryCommand = new QueryCommand({
      TableName: process.env.JOB_POSTINGS_TABLE as string,
      IndexName: "ClinicIdIndex",
      KeyConditionExpression: "clinicId = :clinicId",
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId },
        ":temporary": { S: "temporary" }
      },
      FilterExpression: "job_type = :temporary"
    });

    const result = await dynamodb.send(queryCommand);

    const allJobs = (result.Items || []).map((item) =>
      unmarshall(item as Record<string, AttributeValue>)
    );

    const temporaryJobs = allJobs.filter(
      (job: any) => job.job_type === "temporary"
    );

    const formattedJobs = temporaryJobs.map((job: any) => ({
      jobId: job.jobId || "",
      jobType: job.job_type || "",
      professionalRole: job.professional_role || "",
      jobTitle: job.job_title || "",
      description: job.job_description || "",
      requirements: job.requirements || [],
      date: job.date || "",
      startTime: job.start_time || "",
      endTime: job.end_time || "",
      hourlyRate: job.hourly_rate ? parseFloat(job.hourly_rate) : 0,
      mealBreak: job.meal_break || false,
      parkingInfo: job.parking_info || "",
      status: job.status || "active",
      fullAddress: `${job.addressLine1 || ""} ${job.addressLine2 || ""} ${
        job.addressLine3 || ""
      }`.trim(),
      city: job.city || "",
      state: job.state || "",
      pincode: job.pincode || "",
      createdAt: job.createdAt || "",
      updatedAt: job.updatedAt || ""
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: `Retrieved ${formattedJobs.length} temporary job(s) for clinicId: ${clinicId}`,
        jobs: formattedJobs
      })
    };
  } catch (error: any) {
    console.error("❌ Error during Lambda execution:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to retrieve temporary jobs",
        details: error.message
      })
    };
  }
};
