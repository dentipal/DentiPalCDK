import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, canWriteClinic } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// Fallback duration for legacy promotion records created before durationDays
// was stored on the item. New records always carry their own durationDays.
const LEGACY_FALLBACK_DURATION_DAYS = 7;

export interface ActivatedPromotion {
  promotionId: string;
  jobId: string;
  planId: string;
  status: "active";
  activatedAt: string;
  expiresAt: string;
  durationDays: number;
  /**
   * True if the promotion was already active and this call was a no-op.
   * Webhook callers use this to distinguish "I just activated it" from
   * "Stripe delivered the same event twice".
   */
  alreadyActive: boolean;
}

/**
 * Core activation logic — no auth, no HTTP concerns. Safe to call from:
 *   • the HTTP activatePromotion handler (after permission check)
 *   • the Stripe webhook handler (Stripe is the trusted caller; auth is via
 *     signature verification, not Cognito)
 *
 * Idempotent: calling on an already-active promotion returns the existing
 * record with alreadyActive=true. This matters because Stripe may deliver
 * the same checkout.session.completed event more than once.
 *
 * Throws on: promotion not found, cancelled/expired state.
 */
export async function activatePromotionById(
  promotionId: string,
  clinicId: string
): Promise<ActivatedPromotion> {
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
    const err: any = new Error("Promotion not found");
    err.code = "PROMOTION_NOT_FOUND";
    throw err;
  }

  // Idempotent short-circuit: already-active promotions are a no-op so that
  // a duplicate Stripe webhook delivery doesn't return an error to Stripe
  // (which would cause Stripe to retry forever).
  if (promotion.status === "active") {
    return {
      promotionId,
      jobId: promotion.jobId,
      planId: promotion.planId,
      status: "active",
      activatedAt: promotion.activatedAt,
      expiresAt: promotion.expiresAt,
      durationDays: promotion.durationDays ?? LEGACY_FALLBACK_DURATION_DAYS,
      alreadyActive: true,
    };
  }

  if (promotion.status === "cancelled" || promotion.status === "expired") {
    const err: any = new Error(`Cannot activate a ${promotion.status} promotion`);
    err.code = "PROMOTION_NOT_ACTIVATABLE";
    throw err;
  }

  const now = new Date();
  const durationDays =
    typeof promotion.durationDays === "number" && promotion.durationDays > 0
      ? promotion.durationDays
      : LEGACY_FALLBACK_DURATION_DAYS;
  const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);

  // Activate the promotion record.
  // ConditionExpression guards against the race where two webhook deliveries
  // arrive in parallel — only the first flip succeeds.
  await ddbDoc.send(new UpdateCommand({
    TableName: JOB_PROMOTIONS_TABLE,
    Key: { jobId: promotion.jobId, promotionId },
    UpdateExpression: "SET #status = :active, activatedAt = :now, expiresAt = :expires, updatedAt = :now",
    ConditionExpression: "#status <> :active",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":active": "active",
      ":now": now.toISOString(),
      ":expires": expiresAt.toISOString(),
    },
  })).catch((err: any) => {
    // ConditionalCheckFailedException means another caller activated first.
    // That's a successful no-op for us.
    if (err?.name !== "ConditionalCheckFailedException") throw err;
  });

  // Denormalize promotion flags onto the job posting so search/list pages
  // can render the badge without a join.
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
    promotionId,
    jobId: promotion.jobId,
    planId: promotion.planId,
    status: "active",
    activatedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    durationDays,
    alreadyActive: false,
  };
}

/**
 * HTTP handler for PUT /promotions/{promotionId}/activate.
 * Used by trusted admin tooling for manual activation. Stripe-driven
 * activation goes through stripeWebhook → activatePromotionById directly.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: corsHeaders(event), body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Extract promotionId from path: /promotions/{promotionId}/activate
    const path = event.path || "";
    const segments = path.split("/").filter(Boolean);
    const activateIdx = segments.indexOf("activate");
    const promotionId = activateIdx > 0 ? segments[activateIdx - 1] : "";

    if (!promotionId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "promotionId is required" }) };
    }

    const clinicId = event.queryStringParameters?.clinicId;
    if (!clinicId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "clinicId query parameter is required" }) };
    }

    const allowed = await canWriteClinic(user.sub, user.groups, clinicId, "manageJobs");
    if (!allowed) {
      return { statusCode: 403, headers: corsHeaders(event), body: JSON.stringify({ error: "You do not have permission to activate this clinic's promotions" }) };
    }

    const activated = await activatePromotionById(promotionId, clinicId);

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "success",
        message: activated.alreadyActive
          ? "Promotion was already active"
          : "Promotion activated successfully",
        promotion: {
          promotionId: activated.promotionId,
          jobId: activated.jobId,
          planId: activated.planId,
          status: activated.status,
          activatedAt: activated.activatedAt,
          expiresAt: activated.expiresAt,
          durationDays: activated.durationDays,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error activating promotion:", error);
    const statusCode =
      error?.code === "PROMOTION_NOT_FOUND" ? 404 :
      error?.code === "PROMOTION_NOT_ACTIVATABLE" ? 400 :
      500;
    return {
      statusCode,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: `Failed to activate promotion: ${error.message || "unknown"}` }),
    };
  }
};
