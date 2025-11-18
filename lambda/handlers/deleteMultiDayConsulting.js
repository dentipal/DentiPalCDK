"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  UpdateItemCommand,
  DeleteItemCommand
} = require("@aws-sdk/client-dynamodb");

const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Allowed groups
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

// CORS headers (unchanged)
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
};

const MULTI_DAY_JOB_TYPE = "multi_day_consulting";

const handler = async (event) => {
  try {
    // 1) Validate token and get userSub
    const userSub = await validateToken(event);
    console.log("Authenticated userSub:", userSub);

    // 2) Check groups
    const groupsClaim =
      event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";
    const groups = groupsClaim.split(",").map(g => g.toLowerCase()).filter(Boolean);
    console.log("User groups:", groups);

    const isAllowed = groups.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "You do not have permission to delete this job." })
      };
    }

    // 3) Extract jobId from proxy path, e.g. /jobs/multiday/{jobId}
    const pathParts = event.pathParameters?.proxy?.split("/") || [];
    const jobId = pathParts[2] || pathParts[pathParts.length - 1];
    if (!jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "jobId is required in path parameters" })
      };
    }

    // 4) Verify the job exists and belongs to the clinic (same table/env names)
    const getJobCommand = new GetItemCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        jobId: { S: jobId }
      }
    });
    const jobResponse = await dynamodb.send(getJobCommand);

    if (!jobResponse.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Multiday job not found or access denied" })
      };
    }

    const job = jobResponse.Item;

    // 5) Ensure it's a multi_day_consulting job
    if (job.job_type?.S !== MULTI_DAY_JOB_TYPE) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `This is not a '${MULTI_DAY_JOB_TYPE}' job. Use the appropriate endpoint for this job type.`
        })
      };
    }

    // 6) Check for active applications in the same applications table
    const applicationsCommand = new QueryCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      KeyConditionExpression: "jobId = :jobId",
      FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
      ExpressionAttributeValues: {
        ":jobId": { S: jobId },
        ":pending": { S: "pending" },
        ":accepted": { S: "accepted" },
        ":negotiating": { S: "negotiating" }
      }
    });
    const applicationsResponse = await dynamodb.send(applicationsCommand);
    const activeApplications = applicationsResponse.Items || [];

    // 7) Update active applications to "job_cancelled"
    if (activeApplications.length > 0) {
      console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);
      for (const application of activeApplications) {
        const applicationId = application.applicationId?.S || "";
        if (!applicationId) {
          console.warn("Skipping application with missing applicationId:", application);
          continue;
        }
        try {
          await dynamodb.send(new UpdateItemCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            Key: {
              jobId: { S: jobId },
              applicationId: { S: applicationId }
            },
            UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":status": { S: "job_cancelled" },
              ":updatedAt": { S: new Date().toISOString() }
            }
          }));
        } catch (updateError) {
          console.warn(`Failed to update application ${applicationId}:`, updateError);
        }
      }
    }

    // 8) Delete the job (same postings table)
    await dynamodb.send(new DeleteItemCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        jobId: { S: jobId }
      }
    }));

    // 9) Return success
    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Multi-day consulting job deleted successfully",
        jobId,
        affectedApplications: activeApplications.length,
        applicationHandling: activeApplications.length > 0
          ? "Active applications have been marked as 'job_cancelled'"
          : "No active applications were affected"
      })
    };

  } catch (error) {
    console.error("Error deleting multi-day consulting job:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to delete multi-day consulting job. Please try again.",
        details: error.message
      })
    };
  }
};

exports.handler = handler;
