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

// Define CORS headers
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // Allow all origins
  "Access-Control-Allow-Credentials": true, // If needed for cookie/auth support
};

const handler = async (event) => {
  try {
    // Step 1: Validate token and get userSub
    const userSub = await validateToken(event);
    console.log("Authenticated userSub:", userSub);

    // Step 2: Extract Cognito groups from event authorizer claims
    const groupsClaim =
      event.requestContext?.authorizer?.claims?.["cognito:groups"] || "";
    const groups = groupsClaim.split(",").map(g => g.toLowerCase()).filter(Boolean);
    console.log("User groups:", groups);

    const isAllowed = groups.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS, // <-- CORS Headers added
        body: JSON.stringify({
          error: "You do not have permission to delete this job."
        })
      };
    }

    // Step 3: Extract jobId from proxy path
    const pathParts = event.pathParameters?.proxy?.split("/") || [];
    const jobId = pathParts[2]; // /jobs/permanent/{jobId}
    if (!jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS, // <-- CORS Headers added
        body: JSON.stringify({
          error: "jobId is required in path parameters"
        })
      };
    }

    // Step 4: Verify the job exists and belongs to the clinic
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
        headers: CORS_HEADERS, // <-- CORS Headers added
        body: JSON.stringify({
          error: "Permanent job not found or access denied"
        })
      };
    }

    const job = jobResponse.Item;

    // Step 5: Verify it's a permanent job
    if (job.job_type?.S !== "permanent") {
      return {
        statusCode: 400,
        headers: CORS_HEADERS, // <-- CORS Headers added
        body: JSON.stringify({
          error: "This is not a permanent job. Use the appropriate endpoint for this job type."
        })
      };
    }

    // Step 6: Check for active applications
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

    // Step 7: Update active applications to "job_cancelled"
    if (activeApplications.length > 0) {
      console.log(`Found ${activeApplications.length} active applications. Updating status to 'job_cancelled'.`);
      for (const application of activeApplications) {
        try {
          await dynamodb.send(new UpdateItemCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            Key: {
              jobId: { S: jobId },
              applicationId: { S: application.applicationId?.S || "" }
            },
            UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
            ExpressionAttributeValues: {
              ":status": { S: "job_cancelled" },
              ":updatedAt": { S: new Date().toISOString() }
            }
          }));
        } catch (updateError) {
          console.warn(`Failed to update application ${application.applicationId?.S}:`, updateError);
        }
      }
    }

    // Step 8: Delete the job
    const deleteCommand = new DeleteItemCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        jobId: { S: jobId }
      }
    });
    await dynamodb.send(deleteCommand);

    // Step 9: Return success
    return {
      statusCode: 200,
      headers: CORS_HEADERS, // <-- CORS Headers added
      body: JSON.stringify({
        message: "Permanent job deleted successfully",
        jobId,
        affectedApplications: activeApplications.length,
        applicationHandling: activeApplications.length > 0
          ? "Active applications have been marked as 'job_cancelled'"
          : "No active applications were affected"
      })
    };

  } catch (error) {
    console.error("Error deleting permanent job:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS, // <-- CORS Headers added
      body: JSON.stringify({
        error: "Failed to delete permanent job. Please try again.",
        details: error.message
      })
    };
  }
};

exports.handler = handler;