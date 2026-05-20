import {
  DynamoDBClient,
  UpdateItemCommand,
  UpdateItemCommandInput,
  DynamoDBClientConfig,
  QueryCommand,
} from "@aws-sdk/client-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult
} from "aws-lambda";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

// --- Constants and Initialization ---

const REGION: string = process.env.REGION!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";
const POSTINGS_JOB_INDEX = process.env.JOB_ID_INDEX || "jobId-index-1";

const clientConfig: DynamoDBClientConfig = { region: REGION };
const dynamodb = new DynamoDBClient(clientConfig);
const eb = new EventBridgeClient({ region: REGION });

const ALLOWED_GROUPS = new Set<string>(["root", "clinicadmin", "clinicmanager"]);

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj),
});

function isAuthError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : "";
  return (
    msg === "Authorization header missing" ||
    msg.startsWith("Invalid authorization header") ||
    msg === "Invalid access token format" ||
    msg === "Failed to decode access token" ||
    msg === "User sub not found in token claims"
  );
}

// --- Type Definitions ---

/* ------------------------------------------------------------------------- */
/** Converts a group name to a normalized, lowercase, alphanumeric string. */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");
/* ------------------------------------------------------------------------- */

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
  const method = event.httpMethod || (event.requestContext as any)?.http?.method;

  // CORS Preflight
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }

  try {
    // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    
    const groups = userInfo.groups || [];
    const normalizedGroups: string[] = groups.map(normalize);

    const isAllowed: boolean = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));

    if (!isAllowed) {
      return json(event, 403, {
        status: "error",
        statusCode: 403,
        error: "Forbidden",
        message: "Insufficient permissions to reject applications",
      });
    }

    // 2. Extract and Validate Path Parameters (clinicId and jobId)
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
      return json(event, 400, {
        status: "error",
        statusCode: 400,
        error: "Bad Request",
        message: "Both clinicId and jobId are required in the path (e.g., /123/reject/456)",
      });
    }

    // 3. Extract and Validate Body Parameter (professionalUserSub)
    let body: { professionalUserSub?: string } = {};
    if (event.body) {
      let raw = event.body;
      if (event.isBase64Encoded) raw = Buffer.from(raw, "base64").toString("utf-8");
      try {
        body = JSON.parse(raw);
      } catch {
        return json(event, 400, {
          status: "error",
          statusCode: 400,
          error: "Bad Request",
          message: "Invalid JSON format in body",
        });
      }
    }
    const professionalUserSub: string | undefined = body.professionalUserSub;

    if (!professionalUserSub) {
      return json(event, 400, {
        status: "error",
        statusCode: 400,
        error: "Bad Request",
        message: "professionalUserSub is required in the request body",
      });
    }

    // 4. Update DynamoDB
    // Append a statusHistory entry in the same UpdateItem so the audit trail
    // is consistent with the status flip. `if_not_exists` covers legacy
    // applications created before the statusHistory rollout. The
    // ConditionExpression makes this idempotent — re-clicking Reject on an
    // already-rejected applicant lands in the catch branch and skips the
    // EventBridge fan-out below.
    const nowIso = new Date().toISOString();
    const updateParams: UpdateItemCommandInput = {
      TableName: process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications",
      Key: {
        jobId: { S: jobId },
        professionalUserSub: { S: professionalUserSub }
      },
      UpdateExpression:
        "SET applicationStatus = :rejected, updatedAt = :now, " +
        "statusHistory = list_append(if_not_exists(statusHistory, :empty), :entry)",
      ConditionExpression: "applicationStatus <> :rejected",
      ExpressionAttributeValues: {
        ":rejected": { S: "rejected" },
        ":now": { S: nowIso },
        ":empty": { L: [] },
        ":entry": {
          L: [
            {
              M: {
                status: { S: "rejected" },
                at: { S: nowIso },
                actorId: { S: userInfo.sub || "clinic" },
                actorRole: { S: "clinic" },
              },
            },
          ],
        },
      },
    };

    let alreadyRejected = false;
    try {
      await dynamodb.send(new UpdateItemCommand(updateParams));
    } catch (e) {
      if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
        alreadyRejected = true;
        console.log("[rejectProf] Application already rejected; treating as no-op", {
          jobId,
          professionalUserSub,
        });
      } else {
        throw e;
      }
    }

    if (alreadyRejected) {
      return json(event, 200, {
        status: "success",
        statusCode: 200,
        message: "Job application already rejected — no changes applied",
        data: { jobId, professionalUserSub },
        idempotent: true,
        timestamp: nowIso,
      });
    }

    console.log(`Application for job ${jobId} by professional ${professionalUserSub} rejected successfully.`);

    // 5. Publish EventBridge event for downstream notification (email).
    // Best-effort: a failure here is non-fatal so the reject still completes.
    try {
      const jobRes = await dynamodb.send(new QueryCommand({
        TableName: JOB_POSTINGS_TABLE,
        IndexName: POSTINGS_JOB_INDEX,
        KeyConditionExpression: "jobId = :jid",
        ExpressionAttributeValues: { ":jid": { S: jobId } },
        Limit: 1,
      }));
      const jobItem = (jobRes.Items || [])[0];
      const shiftDetails = {
        role: jobItem?.professional_role?.S,
        date: jobItem?.date?.S || jobItem?.start_date?.S,
        startTime: jobItem?.start_time?.S,
        endTime: jobItem?.end_time?.S,
        location: jobItem?.city?.S || jobItem?.fullAddress?.S,
        rate: jobItem?.rate?.N ? Number(jobItem.rate.N) : undefined,
        jobType: jobItem?.job_type?.S,
      };
      await eb.send(new PutEventsCommand({
        Entries: [{
          Source: "denti-pal.api",
          DetailType: "ShiftEvent",
          Detail: JSON.stringify({
            eventType: "application-rejected",
            clinicId,
            professionalSub: professionalUserSub,
            shiftDetails,
          }),
        }],
      }));
    } catch (publishErr) {
      console.error("[rejectProf] failed to publish application-rejected event (non-fatal):", (publishErr as Error).message);
    }

    // 6. Success Response
    return json(event, 200, {
      status: "success",
      statusCode: 200,
      message: "Job application rejected successfully",
      data: { jobId, professionalUserSub },
      timestamp: new Date().toISOString(),
    });

  } catch (error) {
    console.error("❌ Error rejecting job application:", error);

    if (isAuthError(error)) {
      return json(event, 401, {
        status: "error",
        statusCode: 401,
        error: "Unauthorized",
        message: "Authentication required",
      });
    }

    const detail = error instanceof Error ? error.message : String(error);
    return json(event, 500, {
      status: "error",
      statusCode: 500,
      error: "Internal Server Error",
      message: `Failed to reject job application: ${detail}`,
    });
  }
};