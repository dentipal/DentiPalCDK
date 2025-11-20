import { 
    DynamoDBClient, 
    GetItemCommand, 
    DeleteItemCommand,
    GetItemCommandInput,
    DeleteItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import validation utility
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Get userSub from JWT token
        const userSub = await validateToken(event as any);

        // Step 2: Check if userSub is valid
        if (!userSub) {
            return json(401, {
                error: "Unauthorized",
                statusCode: 401,
                message: "Invalid or expired token",
                details: { issue: "Authentication failed" },
                timestamp: new Date().toISOString()
            });
        }

        // Step 3: Check if the user has a profile
        const getParams: GetItemCommandInput = {
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: userSub },
            },
        };
        const existingProfile = await dynamodb.send(new GetItemCommand(getParams));

        if (!existingProfile.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Professional profile not found",
                details: { userSub: userSub },
                timestamp: new Date().toISOString()
            });
        }

        // Step 4: Check if the profile is the default profile
        // DynamoDB attribute may come back as { BOOL: true } or { S: 'true' }
        const isDefaultAttr = existingProfile.Item.isDefault;
        const isDefault = !!(
            isDefaultAttr && ((isDefaultAttr.BOOL === true) || (isDefaultAttr.S === "true"))
        );

        if (isDefault) {
            return json(409, {
                error: "Conflict",
                statusCode: 409,
                message: "Cannot delete default profile",
                details: { reason: "Set another profile as default first" },
                timestamp: new Date().toISOString()
            });
        }

        // Step 5: Delete the professional profile
        const deleteParams: DeleteItemCommandInput = {
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: userSub },
            },
        };
        await dynamodb.send(new DeleteItemCommand(deleteParams));

        // Step 6: Return success response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Professional profile deleted successfully",
            data: {
                deletedUserSub: userSub,
                deletedAt: new Date().toISOString()
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error deleting professional profile:", err);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete professional profile",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};