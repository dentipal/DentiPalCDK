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
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";

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

/**
 * Get all jobIds the professional has already applied to,
 * using the professionalUserSub-index GSI.
 */
async function getAppliedJobIds(userSub: string): Promise<Set<string>> {
  const jobIds = new Set<string>();
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: JOB_APPLICATIONS_TABLE,
        IndexName: "professionalUserSub-index",
        KeyConditionExpression: "professionalUserSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "jobId",
        ExclusiveStartKey: lastKey,
      })
    );

    resp.Items?.forEach((item) => {
      const id = str(item.jobId);
      if (id) jobIds.add(id);
    });

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return jobIds;
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
    // 1) Get jobIds the professional has already applied to
    const appliedJobIds = await getAppliedJobIds(userSub);

    console.log(`Excluding ${appliedJobIds.size} applied jobs`);

    // 2) Scan all job postings (no role filter — fetch for all roles)
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

    // 3) Exclude already-applied and already-invited jobs
    const filtered = allJobs.filter((job) => {
      const jobId = str(job.jobId);
      return !appliedJobIds.has(jobId);
    });

    // 4) Sort by newest first & slice to limit
    const jobs = filtered
      .map(itemToObject)
      .sort((a, b) => {
        const dateA = new Date(a.createdAt || a.updated_at || 0).getTime();
        const dateB = new Date(b.createdAt || b.updated_at || 0).getTime();
        return dateB - dateA;
      })
      .slice(0, limit);

    return json(200, {
      totalJobs: jobs.length,
      jobs,
    });

  } catch (err: any) {
    console.error("Handler Fatal Error:", err);
    return json(500, {
      error: "Internal Server Error",
      details: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
    });
  }
};
