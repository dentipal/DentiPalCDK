// handlers/getClinicUsers.js
"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Common CORS
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
  "Content-Type": "application/json",
};

// Extract clinicId robustly from different API GW shapes
function extractClinicId(event) {
  // 1) Direct path parameter
  const p = event?.pathParameters;
  if (p?.clinicId) return p.clinicId;

  // 2) Proxy-style param like "clinics/{id}/users"
  if (typeof p?.proxy === "string") {
    // exact match
    let m = p.proxy.match(/^clinics\/([^/]+)\/users\/?$/i);
    if (m && m[1]) return m[1];
    // generic "…/clinics/{id}/users…"
    m = p.proxy.match(/(?:^|\/)clinics\/([^/]+)\/users(?:\/|$)/i);
    if (m && m[1]) return m[1];
  }

  // 3) Raw path (works with /prod prefix too)
  const raw = event?.path || event?.rawPath || "";
  const m = raw.match(/\/clinics\/([^/]+)\/users(?:\/|$)/i);
  if (m && m[1]) return m[1];

  return null;
}

const handler = async (event) => {
  // CORS preflight
  const method = event?.httpMethod || event?.requestContext?.http?.method;
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    // Auth like your other handlers
    await validateToken(event);

    const clinicId = extractClinicId(event);
    if (!clinicId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "clinicId is required in the path (/clinics/{clinicId}/users)" }),
      };
    }

    const res = await dynamodb.send(
      new GetItemCommand({
        TableName: process.env.CLINICS_TABLE, // e.g. DentiPal-Clinics
        Key: { clinicId: { S: clinicId } },
      })
    );

    if (!res.Item) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Clinic not found" }),
      };
    }

    // AssociatedUsers can be SS (String Set) or L (List of {S})
    let associatedUsers = [];
    const au = res.Item.AssociatedUsers;

    if (au?.SS && Array.isArray(au.SS)) {
      associatedUsers = au.SS;
    } else if (au?.L && Array.isArray(au.L)) {
      associatedUsers = au.L.map((v) => v.S).filter(Boolean);
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        clinicId,
        associatedUsers, // array of userSub strings
      }),
    };
  } catch (err) {
    console.error("Error fetching clinic users:", err);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: err?.message || "Internal server error" }),
    };
  }
};

exports.handler = handler;
