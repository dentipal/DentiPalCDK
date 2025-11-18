"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  DynamoDBClient,
  ScanCommand,
  DeleteItemCommand
} = require("@aws-sdk/client-dynamodb");

const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// CORS headers (your spec)
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
};

const handler = async (event) => {
  try {
    // Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: CORS,
        body: JSON.stringify({ message: "CORS preflight OK" })
      };
    }

    // Authenticate professional user
    const userSub = await validateToken(event);

    // Extract applicationId from the proxy path (e.g. /applications/{applicationId})
    const proxyPath = event.pathParameters?.proxy || "";
    const applicationId = proxyPath.split("/").pop();

    if (!applicationId) {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({
          error: "applicationId is required in path parameters"
        })
      };
    }

    // Find the application by scanning (since only applicationId is available)
    const findApplicationCommand = new ScanCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      FilterExpression: "applicationId = :applicationId",
      ExpressionAttributeValues: {
        ":applicationId": { S: applicationId }
      }
    });

    const findResponse = await dynamodb.send(findApplicationCommand);
    if (!findResponse.Items || findResponse.Items.length === 0) {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({
          error: "Job application not found"
        })
      };
    }

    const applicationFound = findResponse.Items[0];

    // Ensure the application belongs to the requesting user
    if (applicationFound.professionalUserSub?.S !== userSub) {
      return {
        statusCode: 403,
        headers: CORS,
        body: JSON.stringify({
          error: "You can only delete your own job applications"
        })
      };
    }

    // Prevent withdrawal of accepted jobs
    const currentStatus = applicationFound.applicationStatus?.S || "pending";
    if (currentStatus === "accepted") {
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({
          error: "Cannot withdraw an accepted job application. Please contact the clinic directly."
        })
      };
    }

    // Proceed with deletion using composite key
    const deleteCommand = new DeleteItemCommand({
      TableName: process.env.JOB_APPLICATIONS_TABLE,
      Key: {
        jobId: { S: applicationFound.jobId?.S || "" },
        professionalUserSub: { S: userSub }
      },
      ConditionExpression: "applicationId = :applicationId",
      ExpressionAttributeValues: {
        ":applicationId": { S: applicationId }
      }
    });

    await dynamodb.send(deleteCommand);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        message: "Job application withdrawn successfully",
        applicationId,
        jobId: applicationFound.jobId?.S,
        withdrawnAt: new Date().toISOString()
      })
    };
  } catch (error) {
    console.error("Error deleting job application:", error);

    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 404,
        headers: CORS,
        body: JSON.stringify({
          error: "Job application not found or already deleted"
        })
      };
    }

    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: "Failed to withdraw job application. Please try again.",
        details: error.message
      })
    };
  }
};

exports.handler = handler;
