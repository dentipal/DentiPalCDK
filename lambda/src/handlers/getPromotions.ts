import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, BatchGetCommand, ScanCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, canAccessClinic, listAccessibleClinicIds } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  try {
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const clinicId = event.queryStringParameters?.clinicId;
    console.log("[getPromotions] sub=", user.sub, "groups=", user.groups, "clinicId=", clinicId);
    if (!clinicId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "clinicId query parameter is required" }) };
    }

    // Resolve which clinics to query. "all" is the frontend sentinel for the
    // aggregated "All Clinics" view in the header; fan out across every clinic
    // the user can read. For a specific clinicId, gate on canAccessClinic.
    let promotions: Record<string, any>[];
    if (clinicId === "all") {
      const accessible = await listAccessibleClinicIds(user.sub, user.groups);
      if (accessible === null) {
        // Root user — listAccessibleClinicIds returns null meaning "every clinic".
        // Paginate a Scan of the promotions table; the admin "all" view is rare.
        console.log("[getPromotions] clinicId=all, root user — scanning full table");
        promotions = [];
        let ExclusiveStartKey: Record<string, any> | undefined;
        do {
          const resp: any = await ddbDoc.send(new ScanCommand({
            TableName: JOB_PROMOTIONS_TABLE,
            ExclusiveStartKey,
          }));
          promotions.push(...(resp.Items || []));
          ExclusiveStartKey = resp.LastEvaluatedKey;
        } while (ExclusiveStartKey);
      } else {
        console.log("[getPromotions] clinicId=all resolved to", accessible.length, "accessible clinics:", accessible);
        const queryResults = await Promise.all(accessible.map((cid) =>
          ddbDoc.send(new QueryCommand({
            TableName: JOB_PROMOTIONS_TABLE,
            IndexName: "clinicId-createdAt-index",
            KeyConditionExpression: "clinicId = :cid",
            ExpressionAttributeValues: { ":cid": cid },
            ScanIndexForward: false,
          }))
        ));
        promotions = queryResults.flatMap((r) => r.Items || []);
      }
    } else {
      const allowed = await canAccessClinic(user.sub, user.groups, clinicId);
      if (!allowed) {
        return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: "You do not have access to this clinic" }) };
      }
      const result = await ddbDoc.send(new QueryCommand({
        TableName: JOB_PROMOTIONS_TABLE,
        IndexName: "clinicId-createdAt-index",
        KeyConditionExpression: "clinicId = :cid",
        ExpressionAttributeValues: { ":cid": clinicId },
        ScanIndexForward: false,
      }));
      promotions = result.Items || [];
    }
    // Sort newest first across the fanned-out result sets.
    promotions.sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));

    // Enrich each promotion with its job's display fields (title, role, type)
    // so the clinic sees "Associate Dentist at Main St" instead of a raw jobId.
    if (promotions.length > 0) {
      const seen = new Set<string>();
      const keys: { clinicUserSub: string; jobId: string }[] = [];
      for (const p of promotions) {
        const k = `${p.clinicUserSub}#${p.jobId}`;
        if (seen.has(k)) continue;
        seen.add(k);
        keys.push({ clinicUserSub: p.clinicUserSub, jobId: p.jobId });
      }

      const jobLookup = new Map<string, { jobTitle?: string; professionalRole?: string; jobType?: string }>();
      for (let i = 0; i < keys.length; i += 100) {
        const chunk = keys.slice(i, i + 100);
        const resp = await ddbDoc.send(new BatchGetCommand({
          RequestItems: {
            [JOB_POSTINGS_TABLE]: {
              Keys: chunk,
              ProjectionExpression: "clinicUserSub, jobId, job_title, professional_role, job_type",
            },
          },
        }));
        for (const row of resp.Responses?.[JOB_POSTINGS_TABLE] || []) {
          jobLookup.set(`${row.clinicUserSub}#${row.jobId}`, {
            jobTitle: row.job_title,
            professionalRole: row.professional_role,
            jobType: row.job_type,
          });
        }
      }

      for (const p of promotions) {
        const hit = jobLookup.get(`${p.clinicUserSub}#${p.jobId}`);
        if (hit) {
          p.jobTitle = hit.jobTitle;
          p.professionalRole = hit.professionalRole;
          p.jobType = hit.jobType;
        }
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        promotions,
        totalCount: promotions.length,
      }),
    };
  } catch (error: any) {
    console.error("Error fetching promotions:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to fetch promotions: ${error.message || "unknown"}` }),
    };
  }
};
