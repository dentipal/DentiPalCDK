import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { isRoot } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize DynamoDB client (AWS SDK v3)
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define interfaces for type safety

// Simplified type for a raw DynamoDB item
interface DynamoDBAssignmentItem {
    userSub?: AttributeValue;
    clinicId?: AttributeValue;
    accessLevel?: AttributeValue;
    assignedAt?: AttributeValue;
    [key: string]: AttributeValue | undefined; // Index signature for compatibility
}

// Interface for the final mapped assignment object
interface AssignmentResponseItem {
    userSub: string;
    clinicId: string;
    accessLevel: string;
    assignedAt: string;
}

// Define the expected body structure (only used if user is Root)
interface RequestBody {
    userSub?: string;
}

/**
 * AWS Lambda handler to retrieve clinic assignments for the authenticated user, 
 * or for a target user if the caller is a Root user.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Extract User/Auth Info
        // Assumes Cognito Authorizer is used and populates claims
        const claims = (event.requestContext.authorizer as any)?.claims;
        const userSub: string = claims?.sub;
        const groupsRaw = claims?.['cognito:groups'];
        
        const groups: string[] = (typeof groupsRaw === 'string' ? groupsRaw.split(',') : [])
            .map((s: string) => s.trim())
            .filter(Boolean);

        if (!userSub) {
            return json(401, {
                error: "Unauthorized",
                statusCode: 401,
                message: "User authentication required",
                details: { issue: "Missing 'sub' claim in JWT token" },
                timestamp: new Date().toISOString()
            });
        }

        // 2. Determine Target UserSub
        // Root users can query for another user's assignments via the request body.
        const body: RequestBody = JSON.parse(event.body || "{}");
        const queryUserSub: string | undefined = body.userSub;
        
        const targetUserSub: string = isRoot(groups) && queryUserSub ? queryUserSub : userSub;

        // 3. Query DynamoDB
        // Queries the USER_CLINIC_ASSIGNMENTS_TABLE using the targetUserSub as the Partition Key.
        const command = new QueryCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: { ":userSub": { S: targetUserSub } },
        });

        const response: QueryCommandOutput = await dynamoClient.send(command);

        // 4. Map and Transform Results
        // FIX: Double cast to unknown first to satisfy TypeScript compiler regarding the type mismatch
        const items = (response.Items || []) as unknown as DynamoDBAssignmentItem[];
        
        const assignments: AssignmentResponseItem[] = items.map(item => ({
            // Safely unwrap AttributeValue string types using optional chaining
            userSub: item.userSub?.S || '',
            clinicId: item.clinicId?.S || '',
            accessLevel: item.accessLevel?.S || '',
            assignedAt: item.assignedAt?.S || '',
        }));

        // 5. Success Response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: `Retrieved ${assignments.length} assignment(s)`,
            data: { assignments },
            timestamp: new Date().toISOString()
        });
    }
    catch (error: any) {
        // 6. Error Response
        console.error("Error retrieving assignments:", error);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to retrieve assignments",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};