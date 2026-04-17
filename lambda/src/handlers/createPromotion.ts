import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-V5-JobPostings";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

const VALID_PLANS = ["basic", "featured", "premium"];

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  try {
    // Auth
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const { jobId, planId } = body;

    if (!jobId || !planId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "jobId and planId are required" }) };
    }

    if (!VALID_PLANS.includes(planId)) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: `Invalid planId. Must be one of: ${VALID_PLANS.join(", ")}` }) };
    }

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
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "Job not found" }) };
    }

    if (job.clinicUserSub !== user.sub) {
      return { statusCode: 403, headers: CORS_HEADERS, body: JSON.stringify({ error: "You can only promote your own jobs" }) };
    }

    // Check if job is already promoted
    if (job.isPromoted) {
      return { statusCode: 409, headers: CORS_HEADERS, body: JSON.stringify({ error: "This job is already promoted" }) };
    }

    // Create promotion record
    const promotionId = uuidv4();
    const now = new Date().toISOString();

    const promotionItem = {
      jobId,
      promotionId,
      clinicUserSub: user.sub,
      clinicId: job.clinicId || "",
      planId,
      status: "pending_payment", // Will be activated after payment
      createdAt: now,
      updatedAt: now,
      activatedAt: null,
      expiresAt: null,
      impressions: 0,
      clicks: 0,
      applications: 0,
    };

    await ddbDoc.send(new PutCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      Item: promotionItem,
    }));

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        promotion: promotionItem,
        // Payment placeholder - to be implemented later
        payment: {
          paymentUrl: null,
          clientSecret: null,
          message: "Payment integration pending. Use the activate endpoint to activate this promotion.",
        },
      }),
    };
  } catch (error: any) {
    console.error("Error creating promotion:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to create promotion: ${error.message || "unknown"}` }),
    };
  }
};
