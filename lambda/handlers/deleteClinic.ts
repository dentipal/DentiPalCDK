import {
    DynamoDBClient,
    DeleteItemCommand,
    DeleteItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Authenticate user
        // Extract Bearer token from Authorization header
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        const groups = userInfo.groups;
        
        let clinicId: string | undefined = event.pathParameters?.clinicId || event.pathParameters?.proxy;

        console.log("Extracted clinicId:", clinicId);

        if (!clinicId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Clinic ID is required",
                details: { pathFormat: "/clinics/{clinicId}" },
                timestamp: new Date().toISOString()
            });
        }

        // Step 3: Authorization check
        // Note: isRoot(groups) is an external utility function assumed to be imported from './utils'.
        if (!isRoot(groups)) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root users can delete clinics",
                details: { requiredGroup: "Root" },
                timestamp: new Date().toISOString()
            });
        }
        
        // Step 4: Execute DeleteItemCommand
        const deleteItemInput: DeleteItemCommandInput = {
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        };

        const command = new DeleteItemCommand(deleteItemInput);
        await dynamoClient.send(command);

        // Step 5: Return success response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Clinic deleted successfully",
            data: { deletedClinicId: clinicId },
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        const err = error as Error & { message?: string; name?: string };
        console.error("Error deleting clinic:", err);

        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete clinic",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};

exports.handler = handler;