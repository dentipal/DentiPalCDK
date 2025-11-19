import {
    DynamoDBClient,
    GetItemCommand,
    DeleteItemCommand,
    DynamoDBClientConfig
} from "@aws-sdk/client-dynamodb";
import {
    APIGatewayProxyEventV2, // Use APIGatewayProxyEvent for V1 payloads
    APIGatewayProxyResultV2 // Use APIGatewayProxyResult for V1 payloads
} from "aws-lambda";

// You must ensure this file exists and exports the `validateToken` function
import { validateToken } from "./utils"; 

// --- Type Definitions ---

/** Defines the expected shape of the utility function for token validation. */
interface TokenValidator {
    (event: APIGatewayProxyEventV2): Promise<string>; // Returns the user's sub/ID
}

/** Standard response format for API Gateway V2 Lambda integration */
type HandlerResponse = APIGatewayProxyResultV2;

// --- Constants and Initialization ---

// Use non-null assertion (!) as we expect these environment variables to be set.
const REGION: string = process.env.REGION!; 
const CLINIC_FAVORITES_TABLE: string = process.env.CLINIC_FAVORITES_TABLE!;

// Initialize DynamoDB Client
const clientConfig: DynamoDBClientConfig = { region: REGION };
const dynamodb = new DynamoDBClient(clientConfig);

// Reusable CORS headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*", // replace with your origin in prod
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
    "Access-Control-Allow-Credentials": "true",
    "Content-Type": "application/json",
};

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
    
    // Check for Preflight OPTIONS request
    if (event && event.requestContext.http.method === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Debug: log the entire event to check the structure
        console.log('Received event:', JSON.stringify(event, null, 2));

        // 1. Validate Token (Authentication)
        // Note: The original JS used `(0, utils_1.validateToken)(event)`, 
        // which is a common way bundlers handle external imports.
        // We use the standard TypeScript call here.
        const userSub: string = await validateToken(event as any); // Type assertion if validateToken expects V1 event

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
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "professionalUserSub is required in the path (e.g., /favorites/user-id-123)"
                })
            };
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
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: `Professional with ID ${professionalUserSub} not found in favorites for user ${userSub}`
                })
            };
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
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Professional removed from favorites successfully",
                clinicUserSub: userSub,
                professionalUserSub: professionalUserSub,
                removedAt: new Date().toISOString()
            })
        };

    } catch (error) {
        console.error("Error removing professional from favorites:", error);
        
        // Safely access the message property of the error object
        const errorMessage: string = (error as Error).message || "An unknown error occurred";

        // 6. Error Response
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: errorMessage })
        };
    }
};