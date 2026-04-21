import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, canWriteClinic } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// Plan duration mapping — update pricing/duration here when finalized
const PLAN_DURATIONS: Record<string, number> = {
  basic: 3,
  featured: 7,
  premium: 14,
};

/**
 * Activates a promotion after payment is confirmed.
 * Currently acts as a placeholder — in production, this will be called
 * by the Stripe webhook handler after payment_intent.succeeded.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  try {
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Extract promotionId from path: /promotions/{promotionId}/activate
    const path = event.path || "";
    const segments = path.split("/").filter(Boolean);
    const activateIdx = segments.indexOf("activate");
    const promotionId = activateIdx > 0 ? segments[activateIdx - 1] : "";

    if (!promotionId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "promotionId is required" }) };
    }

    const clinicId = event.queryStringParameters?.clinicId;
    if (!clinicId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "clinicId query parameter is required" }) };
    }

    const allowed = await canWriteClinic(user.sub, user.groups, clinicId, "manageJobs");
    if (!allowed) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: "You do not have permission to activate this clinic's promotions" }) };
    }

    // Find the promotion within the clinic's partition on the clinicId GSI.
    const result = await ddbDoc.send(new QueryCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      IndexName: "clinicId-createdAt-index",
      KeyConditionExpression: "clinicId = :cid",
      FilterExpression: "promotionId = :pid",
      ExpressionAttributeValues: {
        ":cid": clinicId,
        ":pid": promotionId,
      },
    }));

    const promotion = result.Items?.[0];
    if (!promotion) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "Promotion not found" }) };
    }

    if (promotion.status === "active") {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Promotion is already active" }) };
    }

    if (promotion.status === "cancelled" || promotion.status === "expired") {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Cannot activate a ${promotion.status} promotion` }) };
    }

    const now = new Date();
    const durationDays = PLAN_DURATIONS[promotion.planId] || 7;
    const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

    // Activate the promotion
    await ddbDoc.send(new UpdateCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      Key: { jobId: promotion.jobId, promotionId },
      UpdateExpression: "SET #status = :active, activatedAt = :now, expiresAt = :expires, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":active": "active",
        ":now": now.toISOString(),
        ":expires": expiresAt.toISOString(),
      },
    }));

    // Update the job posting with promotion flags (denormalized for fast queries)
    const jobQuery = await ddbDoc.send(new QueryCommand({
      TableName: JOB_POSTINGS_TABLE,
      IndexName: "jobId-index-1",
      KeyConditionExpression: "jobId = :jobId",
      ExpressionAttributeValues: { ":jobId": promotion.jobId },
      Limit: 1,
    }));

    const job = jobQuery.Items?.[0];
    if (job) {
      await ddbDoc.send(new UpdateCommand({
        TableName: JOB_POSTINGS_TABLE,
        Key: { clinicUserSub: job.clinicUserSub, jobId: promotion.jobId },
        UpdateExpression: "SET isPromoted = :true, promotionId = :pid, promotionPlanId = :planId, promotionExpiresAt = :expires, updatedAt = :now",
        ExpressionAttributeValues: {
          ":true": true,
          ":pid": promotionId,
          ":planId": promotion.planId,
          ":expires": expiresAt.toISOString(),
          ":now": now.toISOString(),
        },
      }));
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        message: "Promotion activated successfully",
        promotion: {
          promotionId,
          jobId: promotion.jobId,
          planId: promotion.planId,
          status: "active",
          activatedAt: now.toISOString(),
          expiresAt: expiresAt.toISOString(),
          durationDays,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error activating promotion:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to activate promotion: ${error.message || "unknown"}` }),
    };
  }
};
