"use strict";

import {
  DynamoDBClient,
  GetItemCommand,
  GetItemCommandOutput,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

// IMPORTANT: Use .js because Lambda runs JS, not TS
import { extractUserFromBearerToken, canAccessClinic } from "./utils.js";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

// Initialize DynamoDB
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj)
});

// Extract clinicId from event object
function extractClinicId(event: APIGatewayProxyEvent): string | null {
  const p = event?.pathParameters;

  // 1) Direct path parameter
  if (p?.clinicId) return p.clinicId;

  // 2) Proxy-style path
  if (typeof p?.proxy === "string") {
    let m = p.proxy.match(/^clinics\/([^/]+)\/users\/?$/i);
    if (m?.[1]) return m[1];

    m = p.proxy.match(/(?:^|\/)clinics\/([^/]+)\/users(?:\/|$)/i);
    if (m?.[1]) return m[1];
  }

  // 3) Raw path — REST API DOES NOT HAVE requestContext.http
  const raw = event?.path || "";

  const m = raw.match(/\/clinics\/([^/]+)\/users(?:\/|$)/i);
  if (m?.[1]) return m[1];

  return null;
}

// Main Handler
export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  // REST API → httpMethod only
  const method = event.httpMethod || "";

  // Handle OPTIONS
  if (method === "OPTIONS") {
    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: "",
    };
  }

  try {
    // Validate Auth Token - Extract access token
    let requesterSub = "";
    let requesterGroups: string[] = [];
    try {
      const authHeader = event.headers?.Authorization || event.headers?.authorization;
      const userInfo = extractUserFromBearerToken(authHeader);
      requesterSub = userInfo.sub;
      requesterGroups = userInfo.groups || [];
    } catch (authError: any) {
      return json(event, 401, { error: authError.message || "Invalid access token" });
    }

    // Get clinicId
    const clinicId = extractClinicId(event);

    if (!clinicId) {
      return json(event, 400, {
        error: "clinicId is required in the path (/clinics/{clinicId}/users)",
      });
    }

    // Membership gate — only clinic members (or Root) may list this clinic's users.
    // Previously auth-only: any logged-in user could list any clinic's roster.
    if (!(await canAccessClinic(requesterSub, requesterGroups, clinicId))) {
      return json(event, 403, { error: "Forbidden: you are not a member of this clinic" });
    }

    // Query DynamoDB
    const res: GetItemCommandOutput = await dynamodb.send(
      new GetItemCommand({
        TableName: process.env.CLINICS_TABLE,
        Key: { clinicId: { S: clinicId } },
      })
    );

    if (!res.Item) {
      return json(event, 404, { error: "Clinic not found" });
    }

    // Extract AssociatedUsers from DynamoDB item
    const au = res.Item.AssociatedUsers;
    let associatedUsers: string[] = [];

    if (au?.SS && Array.isArray(au.SS)) {
      associatedUsers = au.SS;
    } else if (au?.L && Array.isArray(au.L)) {
      // FIX: Filter ensures type is pure string[]
      associatedUsers = au.L.map((v: AttributeValue) => v.S).filter(
        (x): x is string => typeof x === "string"
      );
    }

    // Success Response
    return json(event, 200, {
      clinicId,
      associatedUsers,
    });
    
  } catch (err: any) {
    console.error("Error fetching clinic users:", err);
    return json(event, 500, {
      error: err?.message || "Internal server error",
    });
  }
};