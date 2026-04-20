import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  if ((event.httpMethod || "POST") === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const body = JSON.parse(event.body || "{}");
    const { jobId, promotionId } = body;

    if (!jobId || !promotionId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "jobId and promotionId are required" }),
      };
    }

    // Only count clicks against active promotions — avoids inflating cancelled/expired rows.
    await ddbDoc.send(new UpdateCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      Key: { jobId, promotionId },
      UpdateExpression: "ADD clicks :one",
      ConditionExpression: "#status = :active",
      ExpressionAttributeNames: { "#status": "status" },
      ExpressionAttributeValues: { ":one": 1, ":active": "active" },
    }));

    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  } catch (error: any) {
    // ConditionalCheckFailed = promotion not active; treat as a silent no-op so clients don't care.
    if (error?.name === "ConditionalCheckFailedException") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }
    console.error("Error tracking promotion click:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to track click: ${error.message || "unknown"}` }),
    };
  }
};
