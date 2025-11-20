import {
  DynamoDBClient,
  GetItemCommand,
  DeleteItemCommand,
  DynamoDBClientConfig
} from "@aws-sdk/client-dynamodb";
import {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2
} from "aws-lambda";
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Constants and Initialization ---

const REGION: string = process.env.REGION!;
const CLINIC_FAVORITES_TABLE: string = process.env.CLINIC_FAVORITES_TABLE!;

// Initialize DynamoDB Client
const clientConfig: DynamoDBClientConfig = { region: REGION };
const dynamodb = new DynamoDBClient(clientConfig);

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {

  // Check for Preflight OPTIONS request
  if (event.requestContext?.http?.method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // Debug: log the entire event to check the structure
    console.log('Received event:', JSON.stringify(event, null, 2));

    // 1. Validate Token (Authentication)
    // We use 'as any' because validateToken likely expects APIGatewayProxyEvent (V1)
    const userSub: string = await validateToken(event as any);

    // Debug: log pathParameters to see the structure
    console.log('pathParameters:', JSON.stringify(event.pathParameters, null, 2));

    // 2. Extract professionalUserSub from the proxy path
    // Assuming the path is `/favorites/{professionalUserSub}` and
    // the template configuration maps `{professionalUserSub}` to `pathParameters.proxy`.
    const fullPath: string = event.pathParameters?.proxy || '';
    const pathParts: string[] = fullPath.split('/');

    // The professionalUserSub is the last part of the path
    const professionalUserSub: string | undefined = pathParts[pathParts.length - 1];

    if (!professionalUserSub) {
      return json(400, {
        error: "professionalUserSub is required in the path (e.g., /favorites/user-id-123)"
      });
    }

    // 3. Check if favorite exists (Read)
    const existingFavorite = await dynamodb.send(new GetItemCommand({
      TableName: CLINIC_FAVORITES_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        professionalUserSub: { S: professionalUserSub }
      }
    }));

    if (!existingFavorite.Item) {
      return json(404, {
        error: `Professional with ID ${professionalUserSub} not found in favorites for user ${userSub}`
      });
    }

    // 4. Delete the favorite
    await dynamodb.send(new DeleteItemCommand({
      TableName: CLINIC_FAVORITES_TABLE,
      Key: {
        clinicUserSub: { S: userSub },
        professionalUserSub: { S: professionalUserSub }
      }
    }));

    // 5. Success Response
    return json(200, {
      message: "Professional removed from favorites successfully",
      clinicUserSub: userSub,
      professionalUserSub: professionalUserSub,
      removedAt: new Date().toISOString()
    });

  } catch (error: any) {
    console.error("Error removing professional from favorites:", error);

    // Safely access the message property of the error object
    const errorMessage: string = error.message || "An unknown error occurred";

    // 6. Error Response
    return json(500, { error: errorMessage });
  }
};