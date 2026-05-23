import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import type Stripe from "stripe";
import { getStripe } from "./stripeClient";
import { activatePromotionById } from "./activatePromotion";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

/**
 * Public Stripe webhook endpoint.
 *
 * Route: POST /webhooks/stripe — NO Cognito authorizer.
 * Authorization is provided by Stripe's signature on the request body,
 * verified below via stripe.webhooks.constructEvent.
 *
 * Two MUST-DO things for this to work:
 *   1. Pass the RAW request body (bytes Stripe sent) to constructEvent.
 *      JSON.parse/re-serialise will break the signature check.
 *      API Gateway sometimes base64-encodes the body; we handle both.
 *   2. Set STRIPE_WEBHOOK_SECRET in the Lambda env — this is the value
 *      shown when you create the webhook endpoint in the Stripe dashboard.
 *
 * Responses:
 *   • 200 — event processed (or ignored — events we don't care about
 *           still return 200 so Stripe stops retrying them).
 *   • 400 — bad signature / malformed payload. Stripe will not retry.
 *   • 500 — internal error during processing. Stripe WILL retry, which is
 *           what we want for transient DDB failures.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const signature =
    event.headers?.["stripe-signature"] ||
    event.headers?.["Stripe-Signature"];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  if (!webhookSecret) {
    console.error("STRIPE_WEBHOOK_SECRET is not configured");
    return { statusCode: 500, body: "Server misconfigured" };
  }

  if (!signature) {
    return { statusCode: 400, body: "Missing stripe-signature header" };
  }

  // Reconstruct the raw body exactly as Stripe sent it.
  // API Gateway flips isBase64Encoded based on Content-Type bindings; we
  // must respect that or the signature check fails.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : (event.body || "");

  const stripe = getStripe();
  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err: any) {
    console.error("Stripe webhook signature verification failed:", err?.message);
    return { statusCode: 400, body: `Webhook Error: ${err?.message || "invalid signature"}` };
  }

  console.log(`Stripe event received: ${stripeEvent.type} (${stripeEvent.id})`);

  try {
    switch (stripeEvent.type) {
      case "checkout.session.completed": {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        // Stripe also fires this for sessions whose payment is still
        // processing (e.g. ACH). Only activate when the payment is paid.
        if (session.payment_status !== "paid") {
          console.log(`Session ${session.id} status=${session.payment_status} — skipping activation`);
          break;
        }
        await handleCheckoutSessionCompleted(session);
        break;
      }

      case "checkout.session.async_payment_succeeded": {
        // For payment methods like ACH that confirm asynchronously.
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        await handleCheckoutSessionCompleted(session);
        break;
      }

      case "checkout.session.expired":
      case "checkout.session.async_payment_failed": {
        const session = stripeEvent.data.object as Stripe.Checkout.Session;
        await markPromotionPaymentFailed(session);
        break;
      }

      default:
        // Ack unknown events so Stripe doesn't retry them.
        console.log(`Ignoring event type ${stripeEvent.type}`);
        break;
    }
  } catch (err: any) {
    console.error(`Failed to process ${stripeEvent.type} (${stripeEvent.id}):`, err);
    // 500 → Stripe retries (good for transient DDB blips).
    return { statusCode: 500, body: JSON.stringify({ error: "Processing failed" }) };
  }

  // Always 200 quickly. Stripe enforces a 30-second timeout and starts
  // retrying after that — keep this handler lean.
  return { statusCode: 200, body: JSON.stringify({ received: true }) };
};

async function handleCheckoutSessionCompleted(session: Stripe.Checkout.Session): Promise<void> {
  const promotionId = session.metadata?.promotionId;
  const clinicId = session.metadata?.clinicId;

  if (!promotionId || !clinicId) {
    // Not one of ours, or someone created a session manually. Log and skip.
    console.warn(`Session ${session.id} missing promotionId/clinicId metadata — ignoring`);
    return;
  }

  const result = await activatePromotionById(promotionId, clinicId);

  // Persist Stripe identifiers on the promotion record for audit / refunds.
  // Failure here is non-fatal — the promotion is already active.
  await ddbDoc.send(new UpdateCommand({
    TableName: JOB_PROMOTIONS_TABLE,
    Key: { jobId: result.jobId, promotionId },
    UpdateExpression:
      "SET stripeSessionId = :sid, stripePaymentIntentId = :pi, paidAt = :paidAt, updatedAt = :now",
    ExpressionAttributeValues: {
      ":sid": session.id,
      ":pi": typeof session.payment_intent === "string" ? session.payment_intent : (session.payment_intent?.id ?? null),
      ":paidAt": new Date().toISOString(),
      ":now": new Date().toISOString(),
    },
  })).catch((err) => {
    console.error(`Failed to persist Stripe IDs on promotion ${promotionId}:`, err);
  });

  console.log(
    `Promotion ${promotionId} ${result.alreadyActive ? "already" : "now"} active (session ${session.id})`
  );
}

async function markPromotionPaymentFailed(session: Stripe.Checkout.Session): Promise<void> {
  const promotionId = session.metadata?.promotionId;
  const clinicId = session.metadata?.clinicId;
  if (!promotionId || !clinicId) return;

  // Look up the promotion to get its jobId (table partition key) — we
  // can't update by promotionId alone.
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
  if (!promotion) return;

  // Only flip pending_payment → payment_failed. Don't override active.
  await ddbDoc.send(new UpdateCommand({
    TableName: JOB_PROMOTIONS_TABLE,
    Key: { jobId: promotion.jobId, promotionId },
    UpdateExpression: "SET #status = :failed, updatedAt = :now, stripeSessionId = :sid",
    ConditionExpression: "#status = :pending",
    ExpressionAttributeNames: { "#status": "status" },
    ExpressionAttributeValues: {
      ":failed": "payment_failed",
      ":pending": "pending_payment",
      ":now": new Date().toISOString(),
      ":sid": session.id,
    },
  })).catch((err: any) => {
    if (err?.name !== "ConditionalCheckFailedException") {
      console.error(`Failed to mark ${promotionId} payment_failed:`, err);
    }
  });
}
