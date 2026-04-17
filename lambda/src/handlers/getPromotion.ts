import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  setOriginFromEvent(event);

  try {
    const user = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
    if (!user?.sub) {
      return { statusCode: 401, headers: CORS_HEADERS, body: JSON.stringify({ error: "Unauthorized" }) };
    }

    // Extract promotionId from path: /promotions/{promotionId}
    const path = event.path || "";
    const segments = path.split("/").filter(Boolean);
    const promotionId = segments[segments.length - 1];

    if (!promotionId) {
      return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "promotionId is required" }) };
    }

    // Query all promotions for this user and find the matching one
    const result = await ddbDoc.send(new QueryCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      IndexName: "clinicUserSub-index",
      KeyConditionExpression: "clinicUserSub = :sub",
      FilterExpression: "promotionId = :pid",
      ExpressionAttributeValues: {
        ":sub": user.sub,
        ":pid": promotionId,
      },
    }));

    const promotion = result.Items?.[0];
    if (!promotion) {
      return { statusCode: 404, headers: CORS_HEADERS, body: JSON.stringify({ error: "Promotion not found" }) };
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        promotion,
      }),
    };
  } catch (error: any) {
    console.error("Error fetching promotion:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: `Failed to fetch promotion: ${error.message || "unknown"}` }),
    };
  }
};
