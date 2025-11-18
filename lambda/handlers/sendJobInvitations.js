"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, QueryCommand, BatchGetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");
const { v4: uuidv4 } = require("uuid");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Change this for prod if you want a specific origin (e.g., https://app.yourdomain.com)
const ORIGIN = process.env.CORS_ORIGIN || "http://localhost:5173";
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  // If you ever send cookies, also add: "Access-Control-Allow-Credentials": "true"
};

const handler = async (event) => {
  try {
    // Handle CORS preflight
    const method = event?.requestContext?.http?.method || event?.httpMethod;
    if (method === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    const userSub = await validateToken(event);
    console.log("Authenticated clinic userSub:", userSub);

    const fullPath = event.pathParameters?.proxy || "";
    const pathParts = fullPath.split("/");
    const jobId = pathParts.includes("jobs") ? pathParts[pathParts.indexOf("jobs") + 1] : null;

    if (!jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "jobId is required in path" }),
      };
    }

    const invitationData = JSON.parse(event.body || "{}");

    if (!Array.isArray(invitationData.professionalUserSubs) || invitationData.professionalUserSubs.length === 0) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "professionalUserSubs must be a non-empty array" }),
      };
    }

    if (invitationData.professionalUserSubs.length > 50) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Maximum 50 professionals can be invited at once" }),
      };
    }

    // Fetch job details to get clinicId
    const jobQuery = await dynamodb.send(new QueryCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      IndexName: "jobId-index",
      KeyConditionExpression: "jobId = :jid",
      ExpressionAttributeValues: { ":jid": { S: jobId } },
      Limit: 1,
    }));

    const job = jobQuery.Items?.[0];
    if (!job) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Job not found or access denied" }),
      };
    }

    const clinicId = job.clinicId?.S;
    if (!clinicId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "clinicId not found in job posting" }),
      };
    }

    const requestItems = {
      [process.env.PROFESSIONAL_PROFILES_TABLE]: {
        Keys: invitationData.professionalUserSubs.map((sub) => ({ userSub: { S: sub } })),
      },
    };

    const professionalsResult = await dynamodb.send(new BatchGetItemCommand({ RequestItems: requestItems }));
    const existingProfessionals = professionalsResult.Responses?.[process.env.PROFESSIONAL_PROFILES_TABLE] || [];
    const existingUserSubs = existingProfessionals.map((p) => p.userSub.S);
    const invalidUserSubs = invitationData.professionalUserSubs.filter((sub) => !existingUserSubs.includes(sub));

    if (invalidUserSubs.length > 0) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Invalid professional IDs: ${invalidUserSubs.join(", ")}` }),
      };
    }

    const jobRole = job.professional_role?.S || "";
    const incompatibleProfessionals = existingProfessionals.filter(
      (p) =>
        p.role?.S !== jobRole &&
        jobRole !== "dual_role_front_da" &&
        p.role?.S !== "dual_role_front_da"
    );

    if (incompatibleProfessionals.length > 0) {
      const names = incompatibleProfessionals.map(
        (p) => `${p.full_name?.S || "Unknown"} (${p.role?.S || "Unknown role"})`
      );
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Role mismatch for professionals: ${names.join(", ")}. Job requires: ${jobRole}`,
        }),
      };
    }

    const timestamp = new Date().toISOString();
    const invitationResults = [];
    const errors = [];

    for (const profSub of invitationData.professionalUserSubs) {
      try {
        const invitationId = uuidv4();

        const invitationItem = {
          invitationId: { S: invitationId },
          jobId: { S: jobId },
          professionalUserSub: { S: profSub },
          clinicUserSub: { S: userSub },
          clinicId: { S: clinicId },
          invitationStatus: { S: "sent" },
          sentAt: { S: timestamp },
          updatedAt: { S: timestamp },
          invitationMessage: {
            S:
              invitationData.invitationMessage ||
              "You have been invited to apply for this position.",
          },
          urgency: { S: invitationData.urgency || "medium" },
          customNotes: { S: invitationData.customNotes || "" },
          resent: { BOOL: false },
          resentCount: { N: "0" },
        };

        await dynamodb.send(
          new PutItemCommand({
            TableName: process.env.JOB_INVITATIONS_TABLE,
            Item: invitationItem,
          })
        );

        invitationResults.push({
          invitationId,
          professionalUserSub: profSub,
          status: "sent",
        });
      } catch (err) {
        console.error(`Failed to invite ${profSub}:`, err);
        errors.push({ professionalUserSub: profSub, error: "Failed to send invitation" });
      }
    }

    const professionalDetails = existingProfessionals.map((p) => ({
      userSub: p.userSub.S,
      full_name: p.full_name?.S || "Unknown",
      role: p.role?.S || "Unknown",
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Invitations processed successfully",
        jobId,
        jobType: job.job_type?.S || "unknown",
        jobRole,
        totalInvited: invitationResults.length,
        successful: invitationResults,
        errors,
        invitationDetails: {
          message:
            invitationData.invitationMessage ||
            "You have been invited to apply for this position.",
          urgency: invitationData.urgency || "medium",
          sentAt: timestamp,
        },
        professionals: professionalDetails,
      }),
    };
  } catch (error) {
    console.error("Fatal error in Lambda:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message || "Internal Server Error" }),
    };
  }
};

exports.handler = handler;
