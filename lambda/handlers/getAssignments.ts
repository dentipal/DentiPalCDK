import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { isRoot, extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// Initialize DynamoDB client (AWS SDK v3)
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj),
});

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

/**
 * AWS Lambda handler to retrieve clinic assignments:
 * - Supports:
 *   - GET /assignments              → current user's assignments
 *   - GET /assignments/{userSub}    → for that user (Root can query anyone, non-root only self)
 */
export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method =
        event.httpMethod ||
        (event as any).requestContext?.http?.method ||
        "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader =
            event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);

        const callerSub = userInfo.sub;
        const groups = userInfo.groups || [];

        // --- STEP 2: Get target userSub from path param (if provided) ---
        const pathUserSub = event.pathParameters?.userSub;

        // --- STEP 3: Authorization / permission logic ---
        let targetUserSub: string;

        if (isRoot(groups)) {
            // Root can query:
            // - specific user via /assignments/{userSub}
            // - self via /assignments (no path param)
            targetUserSub = pathUserSub || callerSub;
        } else {
            // Non-root:
            // - /assignments          → own assignments
            // - /assignments/{userSub} → only allowed if {userSub} === callerSub
            if (pathUserSub && pathUserSub !== callerSub) {
                return json(403, {
                    status: "error",
                    statusCode: 403,
                    error: "Forbidden",
                    message:
                        "You are not allowed to view assignments for this user",
                });
            }
            targetUserSub = callerSub;
        }

        // --- STEP 4: Query DynamoDB for assignments of targetUserSub ---
        const command = new QueryCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": { S: targetUserSub },
            },
        });

        const response: QueryCommandOutput = await dynamoClient.send(command);

        const items =
            (response.Items || []) as unknown as DynamoDBAssignmentItem[];

        const assignments: AssignmentResponseItem[] = items.map((item) => ({
            userSub: item.userSub?.S || "",
            clinicId: item.clinicId?.S || "",
            accessLevel: item.accessLevel?.S || "",
            assignedAt: item.assignedAt?.S || "",
        }));

        // --- STEP 5: Success Response ---
        return json(200, {
            status: "success",
            statusCode: 200,
            message: `Retrieved ${assignments.length} assignment(s) for userSub ${targetUserSub}`,
            data: { assignments },
            timestamp: new Date().toISOString(),
        });
    } catch (error: any) {
        console.error("Error retrieving assignments:", error);

        // Handle auth-related errors as 401
        if (
            error?.message === "Authorization header missing" ||
            error?.message?.startsWith("Invalid authorization header") ||
            error?.message === "Invalid access token format" ||
            error?.message === "Failed to decode access token" ||
            error?.message === "User sub not found in token claims"
        ) {
            return json(401, {
                error: "Unauthorized",
                details: error.message,
            });
        }

        // Generic 500
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to retrieve assignments",
            details: { reason: error.message },
            timestamp: new Date().toISOString(),
        });
    }
};
