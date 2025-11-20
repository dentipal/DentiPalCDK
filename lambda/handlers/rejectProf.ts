import {
  DynamoDBClient,
  UpdateItemCommand,
  UpdateItemCommandInput,
  DynamoDBClientConfig
} from "@aws-sdk/client-dynamodb";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult
} from "aws-lambda";
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Constants and Initialization ---

const REGION: string = process.env.REGION!;

const clientConfig: DynamoDBClientConfig = { region: REGION };
const dynamodb = new DynamoDBClient(clientConfig);

const ALLOWED_GROUPS = new Set<string>(["root", "clinicadmin", "clinicmanager"]);

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

// --- Type Definitions ---

interface CognitoClaims {
  "cognito:groups"?: string | string[];
  "cognito:Groups"?: string | string[];
  [key: string]: any;
}

/* ------------------------------------------------------------------------- */
/**
 * Robustly parses user groups from the Cognito Authorizer claims in the event.
 * Handles string, array, and JSON string representations.
 */
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
  // FIX: Cast requestContext to 'any' to avoid type errors if the definition is strict
  const claims: CognitoClaims = (event.requestContext as any)?.authorizer?.claims || {};
  let raw: string | string[] = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";

  if (Array.isArray(raw)) return raw;

  if (typeof raw === "string") {
    const val = raw.trim();
    if (!val) return [];

    // Attempt to parse as JSON array
    if (val.startsWith("[") && val.endsWith("]")) {
      try {
        const arr = JSON.parse(val);
        if (Array.isArray(arr)) {
          // Filter out any non-string elements just in case
          return arr.filter((item): item is string => typeof item === 'string');
        }
      } catch (e) {
        // If JSON.parse fails, fall through to comma-separated logic
        console.warn("Failed to parse groups as JSON array:", e);
      }
    }

    // Fallback to comma-separated string logic
    return val.split(",")
      .map(s => s.trim())
      .filter(Boolean);
  }

  return [];
}

/** Converts a group name to a normalized, lowercase, alphanumeric string. */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");
/* ------------------------------------------------------------------------- */

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
  const method = event.httpMethod || (event.requestContext as any)?.http?.method;

  // CORS Preflight
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // 1. Extract and Validate Path Parameters (clinicId and jobId)
    // Support both direct path parameters and proxy path
    // /<clinicId>/reject/<jobId>
    let clinicId = event.pathParameters?.clinicId;
    let jobId = event.pathParameters?.jobId;

    // Fallback to parsing path/proxy if specific params aren't mapped
    if ((!clinicId || !jobId) && (event.path || event.pathParameters?.proxy)) {
      const rawPath = event.path || event.pathParameters?.proxy || "";
      const match = rawPath.match(/\/([^/]+)\/reject\/([^/]+)/);
      if (match) {
        clinicId = match[1];
        jobId = match[2];
      }
    }

    if (!clinicId || !jobId) {
      return json(400, {
        error: "Both clinicId and jobId are required in the path (e.g., /123/reject/456)"
      });
    }

    // 2. Validate Token (Authentication)
    // Assume validateToken throws an error on failure, which is caught below
    await validateToken(event as any);

    // 3. Group Authorization
    const rawGroups: string[] = parseGroupsFromAuthorizer(event);
    const normalizedGroups: string[] = rawGroups.map(normalize);

    const isAllowed: boolean = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));

    if (!isAllowed) {
      return json(403, {
        error: "Access denied: insufficient permissions to reject applications. Requires one of: root, clinicadmin, clinicmanager."
      });
    }

    // 4. Extract and Validate Body Parameter (professionalUserSub)
    const body: { professionalUserSub?: string } = JSON.parse(event.body || "{}");
    const professionalUserSub: string | undefined = body.professionalUserSub;

    if (!professionalUserSub) {
      return json(400, {
        error: "professionalUserSub is required in the request body"
      });
    }

    // 5. Update DynamoDB
    const updateParams: UpdateItemCommandInput = {
      TableName: "DentiPal-JobApplications", // Assuming table name is constant, consider using process.env.JOB_APPLICATIONS_TABLE
      Key: {
        jobId: { S: jobId },
        professionalUserSub: { S: professionalUserSub }
      },
      UpdateExpression: "SET applicationStatus = :rejected",
      ExpressionAttributeValues: {
        ":rejected": { S: "rejected" }
      }
    };

    const updateCommand = new UpdateItemCommand(updateParams);
    await dynamodb.send(updateCommand);

    console.log(`Application for job ${jobId} by professional ${professionalUserSub} rejected successfully.`);

    // 6. Success Response
    return json(200, {
      message: `Job application for job ${jobId} by professional ${professionalUserSub} has been rejected successfully`
    });

  } catch (error: any) {
    console.error("❌ Error rejecting job application:", error);

    // 7. Error Response
    return json(500, {
      error: "Failed to reject job application. Please try again.",
      details: error.message || "An unknown error occurred"
    });
  }
};