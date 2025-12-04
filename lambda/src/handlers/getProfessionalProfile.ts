import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/client-dynamodb";

import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // Handle preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: CORS_HEADERS,
        body: "",
      };
    }

    // Extract Bearer token from Authorization header
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;

    const profileId = event.queryStringParameters?.profileId;

    let commandInput: QueryCommandInput;

    if (profileId) {
      commandInput = {
        TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
        KeyConditionExpression:
          "userSub = :userSub AND profileId = :profileId",
        ExpressionAttributeValues: {
          ":userSub": { S: userSub },
          ":profileId": { S: profileId },
        },
      };
    } else {
      commandInput = {
        TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: {
          ":userSub": { S: userSub },
        },
      };
    }

    const result = await dynamodb.send(new QueryCommand(commandInput));

    const profiles =
      result.Items?.map((item) => {
        const profile: Record<string, any> = {};

        Object.entries(item).forEach(([key, value]) => {
          if ("S" in value && value.S !== undefined)
            profile[key] = value.S;
          else if ("N" in value && value.N !== undefined)
            profile[key] = Number(value.N);
          else if ("BOOL" in value && value.BOOL !== undefined)
            profile[key] = value.BOOL;
          else if ("SS" in value && value.SS !== undefined)
            profile[key] = value.SS;
        });

        return profile;
      }) || [];

    return json(200, {
      status: "success",
      statusCode: 200,
      message: profileId ? "Profile retrieved successfully" : "Profiles retrieved successfully",
      data: {
        profiles: profileId ? profiles[0] || null : profiles,
        count: profiles.length
      },
      timestamp: new Date().toISOString()
    });
  } catch (error: any) {
    console.error("Error getting professional profile:", error);

    return json(500, {
      error: "Internal Server Error",
      statusCode: 500,
      message: "Failed to retrieve professional profile",
      details: { reason: error.message },
      timestamp: new Date().toISOString()
    });
  }
};