import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDBClient, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";
const CLINIC_ID_INDEX = process.env.CLINIC_ID_INDEX || "clinicId-index";

const DEFAULT_ACTION_NEEDED_STATUSES =
  (process.env.ACTION_NEEDED_STATUSES || "pending,negotiate").split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const ddb = new DynamoDBClient({ region: REGION });

const json = (statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

async function fetchNegotiationsForApplication(applicationId: string): Promise<any[]> {
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: JOB_NEGOTIATIONS_TABLE,
        KeyConditionExpression: "applicationId = :appId",
        ExpressionAttributeValues: { ":appId": { S: applicationId } },
      })
    );
    return resp.Items || [];
  } catch (err) {
    console.warn(`Failed to fetch negotiations for application ${applicationId}:`, err);
    return [];
  }
}

const str = (attr: any): string => {
  if (!attr || !attr.S) return "";
  return attr.S;
};

function extractClinicIdFromPath(path: string): string {
  // Path format: /clinics/{clinicId}/action-needed
  const match = path.match(/\/clinics\/([^\/]+)\/action-needed/);
  return match ? match[1] : "";
}

function itemToObject(item: Record<string, any>): any {
  const result: any = {};
  Object.entries(item).forEach(([key, attr]: [string, any]) => {
    if (attr.S) result[key] = attr.S;
    else if (attr.N) result[key] = parseFloat(attr.N);
    else if (attr.BOOL) result[key] = attr.BOOL;
    else if (attr.SS) result[key] = attr.SS;
    else if (attr.L) result[key] = attr.L;
    else result[key] = attr;
  });
  return result;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = (event.requestContext as any).http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (method !== "GET") return json(405, { error: "Method not allowed" });

  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return json(401, { error: "Unauthorized", reason: "Missing Authorization header" });
    extractUserFromBearerToken(authHeader);
  } catch (e: any) {
    return json(401, { error: "Unauthorized", reason: e?.message || "Invalid token" });
  }

  const clinicId = event.queryStringParameters?.clinicId || event.pathParameters?.clinicId || extractClinicIdFromPath((event as any).rawPath || event.path || "");
  const aggregateByClinic = event.queryStringParameters?.aggregate === "true";

  const statusesParam = event.queryStringParameters?.statuses;
  const statuses = (statusesParam ? statusesParam.split(",") : DEFAULT_ACTION_NEEDED_STATUSES)
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);

  try {
    let allApplications: any[] = [];

    if (clinicId) {
      console.log(`Querying applications for clinicId: ${clinicId}`);
      const resp = await ddb.send(
        new QueryCommand({
          TableName: JOB_APPLICATIONS_TABLE,
          IndexName: CLINIC_ID_INDEX,
          KeyConditionExpression: "clinicId = :clinicId",
          ExpressionAttributeValues: { ":clinicId": { S: clinicId } },
        })
      );
      allApplications = resp.Items || [];
    } else if (aggregateByClinic) {
      console.log("Scanning all applications");
      const resp = await ddb.send(
        new ScanCommand({
          TableName: JOB_APPLICATIONS_TABLE,
        })
      );
      allApplications = resp.Items || [];
    } else {
      return json(400, { error: "clinicId is required or set ?aggregate=true to get all clinics" });
    }

    const filtered = allApplications.filter((item) => {
      const appStatus = str(item.applicationStatus || item.status).toLowerCase();
      return statuses.includes(appStatus);
    });

    if (aggregateByClinic || !clinicId) {
      const aggregated: Record<string, any> = {};

      for (const app of filtered) {
        const cId = str(app.clinicId);
        const appId = str(app.applicationId);

        if (!aggregated[cId]) {
          aggregated[cId] = {
            clinicId: cId,
            totalApplications: 0,
            pendingApplications: [],
            negotiatingApplications: [],
            totalPending: 0,
            totalNegotiating: 0,
          };
        }

        aggregated[cId].totalApplications += 1;
        const appStatus = str(app.applicationStatus || app.status);
        const appObj = itemToObject(app);

        const negotiations = await fetchNegotiationsForApplication(appId);
        appObj.negotiations = negotiations.map(itemToObject);

        if (appStatus === "PENDING") {
          aggregated[cId].pendingApplications.push(appObj);
          aggregated[cId].totalPending += 1;
        } else if (appStatus === "NEGOTIATE") {
          aggregated[cId].negotiatingApplications.push(appObj);
          aggregated[cId].totalNegotiating += 1;
        }
      }

      const clinicSummaries = Object.values(aggregated).sort(
        (a, b) => b.totalApplications - a.totalApplications
      );

      return json(200, {
        type: "aggregated",
        totalClinics: clinicSummaries.length,
        statuses,
        clinicSummaries,
      });
    }

    const applicationsWithNegotiations = await Promise.all(
      filtered.map(async (app) => {
        const appObj = itemToObject(app);
        const appId = str(app.applicationId);
        const negotiations = await fetchNegotiationsForApplication(appId);
        appObj.negotiations = negotiations.map(itemToObject);
        return appObj;
      })
    );

    return json(200, {
      type: "single_clinic",
      clinicId,
      statuses,
      count: applicationsWithNegotiations.length,
      applications: applicationsWithNegotiations,
    });
  } catch (err: any) {
    console.error("getActionNeeded error:", err);
    return json(500, { error: "Failed to fetch action needed data", details: err?.message });
  }
};