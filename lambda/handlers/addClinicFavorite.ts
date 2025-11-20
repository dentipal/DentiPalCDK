import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    GetItemCommandInput,
    PutItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Define the expected structure for the favorite data in the request body
interface FavoriteRequestBody {
    professionalUserSub: string;
    notes?: string;
    tags?: string[];
}

// Define the Lambda handler function with proper TypeScript types
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    /* Preflight */
    if (event && event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Authenticate the clinic user
        // We cast event to 'any' because APIGatewayProxyEvent doesn't include the Cognito claims object by default
        const userSub: string = await validateToken(event as any); 

        // Step 2: Parse the request body
        const favoriteData: FavoriteRequestBody = JSON.parse(event.body || "{}");

        // Validate required fields
        if (!favoriteData.professionalUserSub) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Required field: professionalUserSub"
                })
            };
        }

        // Step 3: Check if professional exists by looking up their profile
        const professionalCheckInput: GetItemCommandInput = {
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: favoriteData.professionalUserSub }
            }
        };

        const professionalCheck = await dynamodb.send(new GetItemCommand(professionalCheckInput));
        if (!professionalCheck.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Professional not found"
                })
            };
        }

        // Step 4: Check if already in favorites
        const existingFavoriteInput: GetItemCommandInput = {
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                professionalUserSub: { S: favoriteData.professionalUserSub }
            }
        };

        const existingFavorite = await dynamodb.send(new GetItemCommand(existingFavoriteInput));
        if (existingFavorite.Item) {
            return {
                statusCode: 409,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Professional is already in favorites"
                })
            };
        }

        // Step 5: Prepare and put the new favorite item
        const timestamp: string = new Date().toISOString();

        // Build DynamoDB item with explicit AttributeValue structure
        const item: Record<string, AttributeValue> = {
            clinicUserSub: { S: userSub },
            professionalUserSub: { S: favoriteData.professionalUserSub },
            addedAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };

        // Add optional fields
        if (favoriteData.notes) {
            item.notes = { S: favoriteData.notes };
        }
        if (favoriteData.tags && favoriteData.tags.length > 0) {
            item.tags = { SS: favoriteData.tags };
        }

        const putItemInput: PutItemCommandInput = {
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Item: item
        };

        await dynamodb.send(new PutItemCommand(putItemInput));

        // Step 6: Return success response
        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Professional added to favorites successfully",
                clinicUserSub: userSub,
                professionalUserSub: favoriteData.professionalUserSub,
                // Safely extract professional name and role from the check result
                professionalName: professionalCheck.Item?.full_name?.S || 'Unknown',
                professionalRole: professionalCheck.Item?.role?.S || 'Unknown',
                addedAt: timestamp
            })
        };
    }
    catch (error) {
        // Ensure error is treated as a standard Error object for message property
        const err = error as Error;
        console.error("Error adding professional to favorites:", err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: err.message })
        };
    }
};