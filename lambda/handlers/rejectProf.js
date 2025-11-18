"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Reusable CORS headers
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,POST"
};

/* -------- groups parsing (robust for array / string / JSON string) -------- */
function parseGroupsFromAuthorizer(event) {
  const claims = event?.requestContext?.authorizer?.claims || {};
  let raw = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const val = raw.trim();
    if (!val) return [];
    if (val.startsWith("[") && val.endsWith("]")) {
      try {
        const arr = JSON.parse(val);
        return Array.isArray(arr) ? arr : [];
      } catch {}
    }
    return val.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}
const normalize = (g) => g.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);
/* ------------------------------------------------------------------------- */

const handler = async (event) => {
  try {
    // Preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    // Extract clinicId and jobId from the path
    const fullPath = event.path || event.rawPath || "";
    const match = fullPath.match(/\/([^/]+)\/reject\/([^/]+)/);

    const clinicId = match?.[1];
    const jobId = match?.[2];

    if (!clinicId || !jobId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Both clinicId and jobId are required in the path" })
      };
    }

    // Validate the token (await if validateToken is async)
    const userSub = await Promise.resolve(validateToken(event));

    // ---- Group authorization (Root, ClinicAdmin, ClinicManager only) ----
    const rawGroups = parseGroupsFromAuthorizer(event);
    const normalized = rawGroups.map(normalize);
    const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Access denied: insufficient permissions to reject applications" })
      };
    }
    // --------------------------------------------------------------------

    // Extract professionalUserSub from body
    const body = JSON.parse(event.body || "{}");
    const professionalUserSub = body.professionalUserSub;

    if (!professionalUserSub) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "professionalUserSub is required in the request body" })
      };
    }

    // Update applicationStatus to "rejected" in DentiPal-JobApplications
    const updateCommand = new UpdateItemCommand({
      TableName: "DentiPal-JobApplications",
      Key: {
        jobId: { S: jobId },
        professionalUserSub: { S: professionalUserSub }
      },
      UpdateExpression: "SET applicationStatus = :rejected",
      ExpressionAttributeValues: {
        ":rejected": { S: "rejected" }
      }
    });

    await dynamodb.send(updateCommand);

    console.log(`Application for job ${jobId} by professional ${professionalUserSub} rejected.`);

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Job application has been rejected successfully"
      })
    };

  } catch (error) {
    console.error("❌ Error rejecting job application:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        error: "Failed to reject job application. Please try again.",
        details: error?.message
      })
    };
  }
};

exports.handler = handler;
