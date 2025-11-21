import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { 
    DynamoDBClient, 
    QueryCommand, 
    QueryCommandInput, 
    QueryCommandOutput 
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// Initialize DynamoDB Client V3
const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE!;

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        // Throws error if invalid
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // Query user addresses from DynamoDB
        const params: QueryCommandInput = {
            TableName: USER_ADDRESSES_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": { S: userSub },
            },
        };

        const result: QueryCommandOutput = await dynamodb.send(new QueryCommand(params));
        
        // Unmarshall items from DynamoDB format to standard JSON
        const addresses = (result.Items || []).map(item => unmarshall(item));

        if (addresses.length === 0) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "No addresses found for this user" }),
            };
        }

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "User addresses retrieved successfully",
                addresses: addresses,
                totalCount: addresses.length,
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving user addresses:", error);

        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Failed to retrieve user addresses" }),
        };
    }
};