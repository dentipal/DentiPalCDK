import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
} from "aws-lambda";

import {
  DynamoDBClient,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";

import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// `unmarshall` from @aws-sdk/util-dynamodb returns DynamoDB SS attributes as
// JavaScript `Set` objects. JSON.stringify on a Set emits "{}" (no enumerable
// own properties), so array-shaped fields like `specializations`, `skills`,
// and `certificates` arrive at the client as `{}` and fail Array.isArray
// checks — making the UI think the saved values are empty.
const setsToArrays = (value: unknown): unknown => {
  if (value instanceof Set) return Array.from(value);
  if (Array.isArray(value)) return value.map(setsToArrays);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = setsToArrays(v);
    }
    return out;
  }
  return value;
};

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(setsToArrays(bodyObj)),
});

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
  try {
    // Handle preflight
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders(event),
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

    const profiles = result.Items?.map((item) => unmarshall(item)) || [];

    return json(event, 200, {
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

    return json(event, 500, {
      error: "Internal Server Error",
      statusCode: 500,
      message: "Failed to retrieve professional profile",
      details: { reason: error.message },
      timestamp: new Date().toISOString()
    });
  }
};