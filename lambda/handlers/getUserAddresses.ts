import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDB } from "aws-sdk";
import { verifyToken } from "./utils";

const dynamodb = new DynamoDB.DocumentClient();
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE!;

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    try {
        // Verify JWT token and get user info
        const userInfo = await verifyToken(event);

        if (!userInfo) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Unauthorized - Invalid or expired token" }),
            };
        }

        const userSub: string = userInfo.sub;

        // Query user addresses from DynamoDB
        const params: DynamoDB.DocumentClient.QueryInput = {
            TableName: USER_ADDRESSES_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": userSub,
            },
        };

        const result = await dynamodb.query(params).promise();

        if (!result.Items || result.Items.length === 0) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: "No addresses found for this user" }),
            };
        }

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "User addresses retrieved successfully",
                addresses: result.Items,
                totalCount: result.Items.length,
            }),
        };
    } catch (error) {
        console.error("Error retrieving user addresses:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: "Failed to retrieve user addresses" }),
        };
    }
};
