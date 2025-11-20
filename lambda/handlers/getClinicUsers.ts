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
import { validateToken } from "./utils.js";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize DynamoDB
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
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
      headers: CORS_HEADERS,
      body: "",
    };
  }

  try {
    // Validate Auth Token
    await validateToken(event);

    // Get clinicId
    const clinicId = extractClinicId(event);

    if (!clinicId) {
      return json(400, {
        error: "clinicId is required in the path (/clinics/{clinicId}/users)",
      });
    }

    // Query DynamoDB
    const res: GetItemCommandOutput = await dynamodb.send(
      new GetItemCommand({
        TableName: process.env.CLINICS_TABLE,
        Key: { clinicId: { S: clinicId } },
      })
    );

    if (!res.Item) {
      return json(404, { error: "Clinic not found" });
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
    return json(200, {
      clinicId,
      associatedUsers,
    });
    
  } catch (err: any) {
    console.error("Error fetching clinic users:", err);
    return json(500, {
      error: err?.message || "Internal server error",
    });
  }
};