import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
// Updated imports to use the new token extraction utility
import { isRoot, extractUserFromBearerToken } from './utils';
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define allowed access levels for validation
type AccessLevel = 'ClinicAdmin' | 'ClinicManager' | 'ClinicViewer' | 'Professional';
const VALID_ACCESS_LEVELS: AccessLevel[] = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];

// Define the expected structure of the request body
interface AssignClinicRequestBody {
    userSub: string;
    clinicId: string;
    accessLevel: AccessLevel;
}

// --- Lambda Handler ---

/**
 * Assigns a user to a specific clinic with a defined access level.
 * This operation is restricted to users in the 'Root' Cognito group.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization Check (Root User)
        // Extract Access Token from Authorization header
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        
        // Use the new utility to decode the Access Token
        const userInfo = extractUserFromBearerToken(authHeader);
        const groups = userInfo.groups;

        // Check if the user is in the 'Root' group
        if (!isRoot(groups)) {
            console.warn(`[AUTH] User groups [${groups.join(',')}] is not a Root user. Access denied.`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied",
                details: { requiredGroup: "Root", userGroups: groups },
                timestamp: new Date().toISOString()
            });
        }

        // 2. Input Validation
        const { userSub, clinicId, accessLevel } = JSON.parse(event.body || '{}') as AssignClinicRequestBody;

        if (!userSub || !clinicId || !accessLevel) {
            console.warn("[VALIDATION] Missing required fields: userSub, clinicId, or accessLevel.");
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields",
                details: { requiredFields: ["userSub", "clinicId", "accessLevel"] },
                timestamp: new Date().toISOString()
            });
        }

        if (!VALID_ACCESS_LEVELS.includes(accessLevel)) {
            console.warn(`[VALIDATION] Invalid access level provided: ${accessLevel}`);
            return json(400, {
                error: "Bad Request",
                message: "Invalid access level",
                details: { validLevels: VALID_ACCESS_LEVELS, providedLevel: accessLevel },
                timestamp: new Date().toISOString()
            });
        }

        // 3. DynamoDB Put Operation
        const now = new Date().toISOString();
        console.log(`[DB] Assigning user ${userSub} to clinic ${clinicId} with level ${accessLevel}`);

        const command = new PutItemCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE, // Ensure this ENV var is set
            Item: {
                // DynamoDB SDK v3 requires AttributeValue types (S, N, L, M, etc.)
                userSub: { S: userSub },
                clinicId: { S: clinicId },
                accessLevel: { S: accessLevel },
                assignedAt: { S: now },
            },
        });

        await dynamoClient.send(command);

        // 4. Success Response
        return json(200, {
            status: "success",
            message: "User assigned to clinic successfully",
            data: {
                userSub,
                clinicId,
                accessLevel,
                assignedAt: now
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        // Use type assertion for better error logging
        const err = error as Error;
        console.error("Error assigning user to clinic:", err);
        
        // Handle specific error cases if needed (e.g., token errors)
        const isAuthError = err.message.includes("Authorization header missing") || 
                            err.message.includes("Invalid access token");

        if (isAuthError) {
             return json(401, {
                error: "Unauthorized",
                message: err.message,
                timestamp: new Date().toISOString()
            });
        }

        return json(500, {
            error: "Internal Server Error",
            message: "Failed to assign user to clinic",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};