"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils"); // your existing token validator

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const corsHeaders = {
  "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/** Minimal unmarshall tailored to your item shape */
const unmarshall = (item) => {
  const obj = {};
  if (!item) return obj;
  for (const [k, v] of Object.entries(item)) {
    if ("S" in v) obj[k] = v.S;
    else if ("N" in v) obj[k] = Number(v.N);
    else if ("BOOL" in v) obj[k] = v.BOOL;
    else if ("SS" in v) obj[k] = v.SS;
    else if ("L" in v) obj[k] = v.L.map(unmarshall);
    else if ("M" in v) obj[k] = unmarshall(v.M);
  }
  return obj;
};

/**
 * Normalize and split the request path into segments:
 * - Handles REST API `event.path` (e.g., "/prod/profiles/123")
 * - Handles HTTP API v2 `requestContext.http.path`
 * - Removes stage prefix if present
 */
function getPathSegments(event) {
  const raw =
    event.path ||
    event.requestContext?.http?.path ||
    (event.requestContext?.path || ""); // older shapes

  const stage = event.requestContext?.stage;
  let p = raw || "";

  // ensure leading slash removed for consistent split
  if (p.startsWith("/")) p = p.slice(1);

  // strip stage prefix if present: "prod/..." -> "..."
  if (stage && p.startsWith(stage + "/")) {
    p = p.slice(stage.length + 1);
  }

  return p.split("/").filter(Boolean);
}

/**
 * Extract userSub when using a greedy proxy route (/{proxy+}).
 * Accepts:
 *   - pathParameters.userSub (direct param routes)
 *   - pathParameters.proxy = "profiles/<userSub>(/...)" (greedy proxy)
 *   - fallback by parsing the full path
 */
function getUserSubFromEvent(event) {
  // 1) direct param (if route is /profiles/{userSub})
  if (event.pathParameters?.userSub) {
    return event.pathParameters.userSub;
  }

  // 2) greedy proxy (/{proxy+})
  const proxyStr = event.pathParameters?.proxy;
  if (proxyStr) {
    const parts = proxyStr.split("/").filter(Boolean);
    // expect ["profiles", "<userSub>"]
    if (parts.length >= 2 && parts[0] === "profiles") {
      return parts[1];
    }
  }

  // 3) fallback: parse full path (handles /prod/profiles/<userSub>)
  const segs = getPathSegments(event);
  const idx = segs.findIndex((s) => s === "profiles");
  if (idx >= 0 && segs[idx + 1]) {
    return segs[idx + 1];
  }

  return undefined;
}

function getMethod(event) {
  // REST API: event.httpMethod ; HTTP API v2: requestContext.http.method
  return event.httpMethod || event.requestContext?.http?.method || "GET";
}

const handler = async (event) => {
  try {
    // CORS preflight
    if (getMethod(event) === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: "" };
    }

    // Validate caller token (clinic/user)
    await validateToken(event);

    // Extract userSub for proxy route
    const professionalUserSub = getUserSubFromEvent(event);

    if (!professionalUserSub) {
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({
          error: "Professional userSub missing from path",
          debug: {
            pathParameters: event.pathParameters ?? null,
            fullPath:
              event.path ||
              event.requestContext?.http?.path ||
              event.requestContext?.path ||
              null,
            stage: event.requestContext?.stage || null,
            segments: getPathSegments(event),
          },
        }),
      };
    }

    // Query DynamoDB for the professional's profile(s)
    const command = new QueryCommand({
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // e.g. "DentiPal-ProfessionalProfiles"
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: {
        ":userSub": { S: professionalUserSub },
      },
    });

    const result = await dynamodb.send(command);
    const profiles = result.Items?.map(unmarshall) ?? [];

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ profile: profiles[0] || null }),
    };
  } catch (error) {
    console.error("Error getting public professional profile:", error);
    const statusCode =
      typeof error?.message === "string" &&
      error.message.toLowerCase().includes("token")
        ? 401
        : 500;

    return {
      statusCode,
      headers: corsHeaders,
      body: JSON.stringify({ error: error.message || "Internal server error" }),
    };
  }
};

exports.handler = handler;
