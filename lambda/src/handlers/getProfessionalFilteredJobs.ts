import {
  DynamoDBClient,
  ScanCommand,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-ProfessionalProfiles";

// *** IMPORTANT: If userSub is NOT the main Partition Key, set your Index Name here ***
// Example: "userSub-index" or "UserSubGSI"
const USER_SUB_INDEX_NAME = process.env.USER_SUB_INDEX_NAME || undefined; 

const ddb = new DynamoDBClient({ region: REGION });

const json = (statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

const str = (attr: AttributeValue | undefined): string => {
  if (!attr || !("S" in attr)) return "";
  return (attr.S as string) || "";
};

function itemToObject(item: Record<string, AttributeValue>): any {
  const result: any = {};
  Object.entries(item).forEach(([key, attr]) => {
    if ("S" in attr) result[key] = attr.S;
    else if ("N" in attr) result[key] = parseFloat(attr.N as string);
    else if ("BOOL" in attr) result[key] = attr.BOOL;
    else if ("SS" in attr) result[key] = attr.SS;
    else if ("L" in attr) result[key] = attr.L;
    else result[key] = attr;
  });
  return result;
}

async function getProfessionalRole(userSub: string): Promise<string | null> {
  // Debug Log: Check exactly what is being sent to DB
  console.log(`[DEBUG] Querying Table: ${PROFESSIONAL_PROFILES_TABLE}, Index: ${USER_SUB_INDEX_NAME}, userSub: ${userSub}`);

  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: PROFESSIONAL_PROFILES_TABLE,
        // If userSub is a GSI, this is REQUIRED. If userSub is the PK, this should be undefined.
        IndexName: USER_SUB_INDEX_NAME, 
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        Limit: 1,
      })
    );

    // Debug Log: Check if items were actually returned
    console.log(`[DEBUG] DB Response Items:`, JSON.stringify(resp.Items));

    const profile = resp.Items?.[0];
    if (!profile) return null;
    return str(profile.role);
  } catch (err: any) {
    // CRITICAL: Do not return null here. Throw the error so we can see it in the API response.
    console.error(`[ERROR] DynamoDB Query Failed:`, err);
    throw new Error(`DynamoDB Error: ${err.message}`);
  }
}

function roleMatchesJob(jobRole: string, professionalRole: string): boolean {
  if (jobRole === professionalRole) return true;
  if (jobRole === "dual_role_front_da") return true;
  if (professionalRole === "dual_role_front_da") return true;
  return false;
}

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext as any)?.http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS")
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (method !== "GET") return json(405, { error: "Method not allowed" });

  let userSub: string | undefined;
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return json(401, { error: "Missing Authorization header" });
    userSub = extractUserFromBearerToken(authHeader).sub;
    if (!userSub) return json(401, { error: "User sub missing in token" });
  } catch (e: any) {
    return json(401, { error: "Unauthorized", reason: e?.message });
  }

  const limit = Math.min(Number(event.queryStringParameters?.limit || 50), 100);

  try {
    // 1) Get professional role
    const professionalRole = await getProfessionalRole(userSub);

    // If null is returned, it means query worked but NO ITEM matches that sub
    if (!professionalRole) {
      console.warn(`[WARN] Profile not found for userSub: ${userSub}`);
      return json(404, {
        error: "Professional profile not found",
        details: `No record found in ${PROFESSIONAL_PROFILES_TABLE} for userSub '${userSub}'`,
        suggestion: "Check if the user has actually created a profile in the DB."
      });
    }

    console.log(`Fetching jobs for role: ${professionalRole}`);

    // 2) Scan job postings
    let allJobs: Record<string, AttributeValue>[] = [];
    let lastEvaluatedKey: Record<string, AttributeValue> | undefined;

    do {
      const resp = await ddb.send(
        new ScanCommand({
          TableName: JOB_POSTINGS_TABLE,
          Limit: 100,
          ExclusiveStartKey: lastEvaluatedKey,
        })
      );
      if (resp.Items) allJobs.push(...resp.Items);
      lastEvaluatedKey = resp.LastEvaluatedKey;
    } while (lastEvaluatedKey && allJobs.length < 1000);

    // 3) Filter by role
    const filtered = allJobs.filter((job) => {
      const jobRole = str(job.professional_role);
      return roleMatchesJob(jobRole, professionalRole);
    });

    // 4) Sort & Slice
    const jobs = filtered
      .map(itemToObject)
      .sort((a, b) => {
        const dateA = new Date(a.createdAt || a.updated_at || 0).getTime();
        const dateB = new Date(b.createdAt || b.updated_at || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, limit);

    return json(200, {
      professionalRole,
      totalJobs: jobs.length,
      jobs,
    });

  } catch (err: any) {
    // This catches the re-thrown DB error
    console.error("Handler Fatal Error:", err);
    return json(500, { 
      error: "Internal Server Error", 
      details: err.message, // This will now show "DynamoDB Error: ValidationException..."
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined 
    });
  }
};