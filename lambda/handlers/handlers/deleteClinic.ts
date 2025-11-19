import {
    DynamoDBClient,
    DeleteItemCommand,
    DeleteItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken, isRoot } from "./utils"; // Assuming isRoot and validateToken are in utils.ts

// Initialize the DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define shared CORS headers for the response
const CORS_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "OPTIONS,DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
};

// Helper for constructing responses
const resp = (statusCode: number, data: any): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(data),
});

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle OPTIONS preflight
    if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

    try {
        // Step 1: Authenticate user
        // We cast event to 'any' for the validateToken utility
        const userSub: string = await validateToken(event as any);

        // Step 2: Get user groups and clinic ID
        // Groups are often passed as a comma-separated string in claims, matching the original JS logic:
        const rawGroups: string | undefined = event.requestContext?.authorizer?.claims?.['cognito:groups'];
        const groups: string[] = rawGroups ? rawGroups.split(',').map(g => g.trim()).filter(Boolean) : [];
        
        let clinicId: string | undefined = event.pathParameters?.clinicId || event.pathParameters?.proxy;

        console.log("Extracted clinicId:", clinicId);

        if (!clinicId) {
            return resp(400, { error: "Clinic ID is required in path parameters" });
        }

        // Step 3: Authorization check
        // Note: isRoot(groups) is an external utility function assumed to be imported from './utils'.
        if (!isRoot(groups)) {
            return resp(403, { error: "Only Root users can delete clinics" });
        }
        
        // Step 4: Execute DeleteItemCommand
        const deleteItemInput: DeleteItemCommandInput = {
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        };

        const command = new DeleteItemCommand(deleteItemInput);
        await dynamoClient.send(command);

        // Step 5: Return success response
        return resp(200, { status: "success", message: "Clinic deleted successfully" });
        
    } catch (error) {
        const err = error as Error & { message?: string; name?: string };
        console.error("Error deleting clinic:", err);

        // Handle specific case where the item might not have existed (although DynamoDB delete is idempotent)
        // If you were using a ConditionExpression like `attribute_exists(clinicId)`, you might handle ConditionalCheckFailedException here.
        
        return resp(500, { error: `Failed to delete clinic: ${err.message || "Internal Server Error"}` });
    }
};

exports.handler = handler;