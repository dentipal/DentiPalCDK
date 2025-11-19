"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
};

/**
 * Unmarshall a single DynamoDB AttributeValue into a JS value.
 * Handles S, N, BOOL, SS, L, M.
 */
const unmarshallAttribute = (attr: AttributeValue | undefined): any => {
  if (!attr) return undefined;

  // String
  if ("S" in attr && attr.S !== undefined) return attr.S;
  // Number
  if ("N" in attr && attr.N !== undefined) return Number(attr.N);
  // Boolean
  if ("BOOL" in attr && attr.BOOL !== undefined) return attr.BOOL;
  // String Set
  if ("SS" in attr && attr.SS !== undefined) return attr.SS;
  // List
  if ("L" in attr && attr.L !== undefined) {
    return attr.L.map((el) => unmarshallAttribute(el));
  }
  // Map
  if ("M" in attr && attr.M !== undefined) {
    return unmarshallMap(attr.M);
  }
  // Binary or other unsupported types -> return as-is (could extend if needed)
  return undefined;
};

/**
 * Unmarshall a DynamoDB map (Record<string, AttributeValue>) into a JS object.
 */
const unmarshallMap = (item: Record<string, AttributeValue> | undefined): any => {
  const obj: any = {};
  if (!item) return obj;

  for (const [k, v] of Object.entries(item)) {
    obj[k] = unmarshallAttribute(v);
  }
  return obj;
};

/**
 * Normalize and split the request path into segments:
 * - Handles REST API `event.path` (e.g., "/prod/profiles/123")
 * - Handles HTTP API v2 `requestContext.http.path`
 * - Removes stage prefix if present
 */
function getPathSegments(event: APIGatewayProxyEvent): string[] {
  const raw =
    event.path ||
    (event.requestContext as any)?.http?.path ||
    (event.requestContext as any)?.path ||
    "";

  const stage = (event.requestContext as any)?.stage;
  let p: string = raw || "";

  if (p.startsWith("/")) p = p.slice(1);

  if (stage && p.startsWith(stage + "/")) {
    p = p.slice(stage.length + 1);
  }

  return p.split("/").filter(Boolean);
}

/**
 * Extract userSub when using a greedy proxy route (/{proxy+}).
 * Accepts:
 *   - event.pathParameters.userSub (direct param routes)
 *   - event.pathParameters.proxy = "profiles/<userSub>(/...)" (greedy proxy)
 *   - fallback by parsing the full path
 */
function getUserSubFromEvent(event: APIGatewayProxyEvent): string | undefined {
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

function getMethod(event: APIGatewayProxyEvent): string {
  // REST API: event.httpMethod ; HTTP API v2: requestContext.http.method
  return event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
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
              (event.requestContext as any)?.http?.path ||
              (event.requestContext as any)?.path ||
              null,
            stage: (event.requestContext as any)?.stage || null,
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

    // ensure Items is typed as array of maps
    const items = (result.Items as Record<string, AttributeValue>[] | undefined) ?? [];

    const profiles = items.map((it) => unmarshallMap(it));

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({ profile: profiles[0] || null }),
    };
  } catch (error: any) {
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
