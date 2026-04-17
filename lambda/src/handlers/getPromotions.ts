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

    // Query promotions for this clinic user via GSI
    const result = await ddbDoc.send(new QueryCommand({
      TableName: JOB_PROMOTIONS_TABLE,
      IndexName: "clinicUserSub-index",
      KeyConditionExpression: "clinicUserSub = :sub",
      ExpressionAttributeValues: { ":sub": user.sub },
      ScanIndexForward: false, // newest first
    }));

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        promotions: result.Items || [],
        totalCount: result.Items?.length || 0,
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
