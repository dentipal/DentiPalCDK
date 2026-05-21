"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
  AdminGetUserCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

/**
 * Names entered during signup are stored only as Cognito attributes
 * (`given_name` / `family_name`). The ProfessionalProfiles row is created later
 * when the professional completes their profile form — so applicants who haven't
 * done that step yet have either no row or a row with empty names, which made
 * clinic-facing UIs render "Unknown Professional".
 *
 * Read-time fallback: if the profile row is missing or its name fields are blank,
 * resolve them from Cognito and merge in. DDB still wins when it has values, so
 * any name a professional later edits in their profile remains the source of truth.
 */
async function fetchCognitoNames(userSub: string): Promise<{ first_name?: string; last_name?: string }> {
  const userPoolId = process.env.USER_POOL_ID;
  if (!userPoolId) return {};
  try {
    const resp = await cognito.send(new AdminGetUserCommand({
      UserPoolId: userPoolId,
      Username: userSub,
    }));
    const attrs = resp.UserAttributes || [];
    const given = attrs.find((a) => a.Name === "given_name")?.Value || "";
    const family = attrs.find((a) => a.Name === "family_name")?.Value || "";
    const out: { first_name?: string; last_name?: string } = {};
    if (given) out.first_name = given;
    if (family) out.last_name = family;
    return out;
  } catch (err) {
    // Non-fatal: caller falls back to whatever DDB had (possibly nothing).
    console.warn("Cognito name fallback failed for", userSub, err);
    return {};
  }
}

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

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
 * - event.pathParameters.userSub (direct param routes)
 * - event.pathParameters.proxy = "profiles/<userSub>(/...)" (greedy proxy)
 * - fallback by parsing the full path
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
      return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    // Validate caller token (clinic/user)
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    extractUserFromBearerToken(authHeader);

    // Extract userSub for proxy route
    const professionalUserSub = getUserSubFromEvent(event);

    if (!professionalUserSub) {
      return json(event, 400, {
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
      });
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

    // Defense in depth: if the rating denorm step missed avgRating but ratingSum
    // and ratingCount are present, compute it on the fly so the UI gets a number.
    const first = profiles[0];
    if (first && typeof first.avgRating !== "number") {
      const count = typeof first.ratingCount === "number" ? first.ratingCount : 0;
      const sum = typeof first.ratingSum === "number" ? first.ratingSum : 0;
      if (count > 0) {
        first.avgRating = Math.round((sum / count) * 100) / 100;
      }
    }

    // If the DDB row is absent OR its name fields are empty, fill from Cognito.
    // We only touch the empty slots, so a professional who later edits their
    // name in their profile keeps that DDB value as the source of truth.
    const hasFirst = typeof first?.first_name === "string" && first.first_name.trim().length > 0;
    const hasLast = typeof first?.last_name === "string" && first.last_name.trim().length > 0;
    if (!first || !hasFirst || !hasLast) {
      const cognitoNames = await fetchCognitoNames(professionalUserSub);
      if (cognitoNames.first_name || cognitoNames.last_name) {
        const merged = first || { userSub: professionalUserSub };
        if (!hasFirst && cognitoNames.first_name) merged.first_name = cognitoNames.first_name;
        if (!hasLast && cognitoNames.last_name) merged.last_name = cognitoNames.last_name;
        return json(event, 200, { profile: merged });
      }
    }

    return json(event, 200, { profile: first || null });

  } catch (error: any) {
    console.error("Error getting public professional profile:", error);
    const statusCode =
      typeof error?.message === "string" &&
      error.message.toLowerCase().includes("token")
        ? 401
        : 500;

    return json(event, statusCode, {
      error: error.message || "Internal server error",
    });
  }
};