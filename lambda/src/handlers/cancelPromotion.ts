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

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {

  try {
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: corsHeaders(event), body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Extract promotionId from path: /promotions/{promotionId}/cancel
    const path = event.path || "";
    const segments = path.split("/").filter(Boolean);
    const cancelIdx = segments.indexOf("cancel");
    const promotionId = cancelIdx > 0 ? segments[cancelIdx - 1] : "";

    if (!promotionId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "promotionId is required" }) };
    }

    const clinicId = event.queryStringParameters?.clinicId;
    if (!clinicId) {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "clinicId query parameter is required" }) };
    }

    const allowed = await canWriteClinic(user.sub, user.groups, clinicId, "manageJobs");
    if (!allowed) {
      return { statusCode: 403, headers: corsHeaders(event), body: JSON.stringify({ error: "You do not have permission to cancel this clinic's promotions" }) };
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
      return { statusCode: 404, headers: corsHeaders(event), body: JSON.stringify({ error: "Promotion not found" }) };
    }

    if (promotion.status === "cancelled") {
      return { statusCode: 400, headers: corsHeaders(event), body: JSON.stringify({ error: "Promotion is already cancelled" }) };
    }

    const now = new Date().toISOString();

    // Update promotion status to cancelled
    await ddbDoc.send(new UpdateCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      Key: { jobId: promotion.jobId, promotionId },
      UpdateExpression: "SET #status = :cancelled, cancelledAt = :now, updatedAt = :now",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: {
        ":cancelled": "cancelled",
        ":now": now,
      },
    }));

    // If promotion was active, remove flags from job posting
    if (promotion.status === "active") {
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
          UpdateExpression: "SET isPromoted = :false, updatedAt = :now REMOVE promotionId, promotionPlanId, promotionExpiresAt",
          ExpressionAttributeValues: {
            ":false": false,
            ":now": now,
          },
        }));
      }
    }

    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        status: "success",
        message: "Promotion cancelled successfully",
      }),
    };
  } catch (error: any) {
    console.error("Error cancelling promotion:", error);
    return {
      statusCode: 500,
      headers: corsHeaders(event),
      body: JSON.stringify({ error: `Failed to cancel promotion: ${error.message || "unknown"}` }),
    };
  }
};
