import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken, canWriteClinic } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { getStripe } from "./stripeClient";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

// Fallback only used in dev — production must set APP_URL.
const APP_URL = process.env.APP_URL || "http://localhost:5173";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

const VALID_PLANS = ["basic", "email", "sms"];

// Server-side source of truth — never trust client-supplied prices.
const PLAN_PER_DAY_CENTS: Record<string, number> = {
  basic: 100,
  email: 200,
  sms: 300,
};

// Friendly plan names for Stripe Checkout line-item display.
const PLAN_DISPLAY_NAMES: Record<string, string> = {
  basic: "Basic Promotion",
  email: "Email Boost Promotion",
  sms: "SMS Boost Promotion",
};

const MIN_DURATION_DAYS = 1;
const MAX_DURATION_DAYS = 30;

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  try {
    // Auth
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: corsHeaders(event), body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const { jobId, planId, durationDays } = body;

    if (!jobId || !planId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "jobId and planId are required" }) };
    }

    if (!VALID_PLANS.includes(planId)) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: `Invalid planId. Must be one of: ${VALID_PLANS.join(", ")}` }) };
    }

    if (
      !Number.isInteger(durationDays) ||
      durationDays < MIN_DURATION_DAYS ||
      durationDays > MAX_DURATION_DAYS
    ) {
      return {
        statusCode: 400,
        headers: corsHeaders(event),
        body: JSON.stringify({
          error: `durationDays is required and must be an integer between ${MIN_DURATION_DAYS} and ${MAX_DURATION_DAYS}`,
        }),
      };
    }

    const perDayPriceCents = PLAN_PER_DAY_CENTS[planId];
    const totalPriceCents = perDayPriceCents * durationDays;

    // Verify the job exists and belongs to this user
    const jobQuery = await ddbDoc.send(new QueryCommand({
      TableName: JOB_POSTINGS_TABLE,
      IndexName: "jobId-index-1",
      KeyConditionExpression: "jobId = :jobId",
      ExpressionAttributeValues: { ":jobId": jobId },
      Limit: 1,
    }));

    const job = jobQuery.Items?.[0];
    if (!job) {
      return { statusCode: 404, headers: corsHeaders(event), body: JSON.stringify({ error: "Job not found" }) };
    }

    if (!job.clinicId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "Job has no clinicId and cannot be promoted" }) };
    }

    const allowed = await canWriteClinic(user.sub, user.groups, job.clinicId, "manageJobs");
    if (!allowed) {
      return { statusCode: 403, headers: corsHeaders(event), body: JSON.stringify({ error: "You do not have permission to promote this clinic's jobs" }) };
    }

    if (job.isPromoted) {
      return { statusCode: 409, headers: corsHeaders(event), body: JSON.stringify({ error: "This job is already promoted" }) };
    }

    // Persist the promotion in pending_payment state BEFORE creating the
    // Stripe session. This way we always have a DB record to correlate the
    // Stripe webhook against — even if the user closes the browser before
    // ever loading the Stripe page.
    //
    // The job posting is NOT denormalized yet (isPromoted stays false).
    // That flip happens in activatePromotionById, called from the Stripe
    // webhook after payment_intent.succeeded → checkout.session.completed.
    const promotionId = uuidv4();
    const nowDate = new Date();
    const now = nowDate.toISOString();

    const promotionItem = {
      jobId,
      promotionId,
      clinicUserSub: job.clinicUserSub,
      clinicId: job.clinicId,
      planId,
      durationDays,
      perDayPriceCents,
      totalPriceCents,
      status: "pending_payment",
      createdAt: now,
      updatedAt: now,
      activatedAt: null,
      // expiresAt is set when the webhook activates the promotion (so the
      // N-day window starts from payment time, not session-create time).
      expiresAt: null,
      impressions: 0,
      clicks: 0,
      applications: 0,
    };

    await ddbDoc.send(new PutCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      Item: promotionItem,
    }));

    // Build the Stripe Checkout Session.
    //
    // We use price_data (inline pricing) rather than pre-created Stripe
    // Products because our pricing is per-day × duration, parameterised
    // server-side. The promotionId travels in metadata so the webhook can
    // find this exact record.
    const stripe = getStripe();
    let session;
    try {
      session = await stripe.checkout.sessions.create({
        mode: "payment",
        line_items: [
          {
            price_data: {
              currency: "usd",
              product_data: {
                name: `${PLAN_DISPLAY_NAMES[planId]} — ${durationDays} day${durationDays === 1 ? "" : "s"}`,
                description: `Promote job ${jobId.slice(0, 8)}… for ${durationDays} days`,
                metadata: {
                  jobId,
                  planId,
                  durationDays: String(durationDays),
                },
              },
              unit_amount: totalPriceCents,
            },
            quantity: 1,
          },
        ],
        // Where Stripe sends the user after they pay / cancel.
        success_url: `${APP_URL}/promote/success?promotion_id=${promotionId}&clinic_id=${job.clinicId}`,
        cancel_url: `${APP_URL}/promote/cancel?promotion_id=${promotionId}&clinic_id=${job.clinicId}`,
        // CRITICAL: metadata is what the webhook handler uses to map the
        // Stripe event back to the promotion + clinic.
        metadata: {
          promotionId,
          jobId,
          clinicId: job.clinicId,
          clinicUserSub: job.clinicUserSub,
        },
        // client_reference_id is also commonly queried in the dashboard.
        client_reference_id: promotionId,
        // Auto-collect tax IDs / addresses can be turned on later; keep
        // first-iteration minimal.
        allow_promotion_codes: false,
        // 30-minute session; expired sessions cannot be paid against.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
      });
    } catch (stripeErr: any) {
      // If Stripe call fails, the pending_payment record is still in DDB
      // but unusable. Mark it as failed so it doesn't clutter the dashboard.
      console.error("Stripe session creation failed:", stripeErr);
      await ddbDoc.send(new PutCommand({
        TableName: JOB_PROMOTIONS_TABLE,
        Item: { ...promotionItem, status: "payment_failed", updatedAt: new Date().toISOString() },
      })).catch(() => { /* swallow secondary error — original is what matters */ });

      return {
        statusCode: 502,
        headers: corsHeaders(event),
        body: JSON.stringify({
          error: "Payment provider unavailable. Please try again.",
        }),
      };
    }

    return {
      statusCode: 201,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "success",
        promotion: promotionItem,
        payment: {
          // Frontend redirects the browser to this URL.
          checkoutUrl: session.url,
          // Stripe Checkout (hosted) doesn't use client_secret — that's
          // only for Elements/Embedded. Keep the field for API stability.
          clientSecret: null,
          sessionId: session.id,
        },
      }),
    };
  } catch (error: any) {
    console.error("Error creating promotion:", error);
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: `Failed to create promotion: ${error.message || "unknown"}` }),
    };
  }
};
