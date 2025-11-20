import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
// Assuming 'isRoot' is defined in a separate file named 'utils.ts'
import { isRoot } from './utils';
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

/**
 * DynamoDBClient instance using the AWS SDK v3.
 * It reads the region from the environment variables.
 */
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
 * @param event The API Gateway Proxy event.
 * @returns An APIGatewayProxyResult object.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization Check (Root User)
        // Extract Cognito groups from the Authorizer claims
        // Note: This specific line assumes REST API Authorizer structure. 
        // If migrating to HTTP API, you may need to check event.requestContext.authorizer.jwt.claims['cognito:groups']
        const groupsString = event.requestContext.authorizer?.claims?.['cognito:groups'];
        const groups = typeof groupsString === 'string' ? groupsString.split(',') : [];

        if (!isRoot(groups)) {
            console.warn(`[AUTH] User groups [${groups.join(',')}] is not a Root user. Access denied.`);
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
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
                statusCode: 400,
                message: "Missing required fields",
                details: { requiredFields: ["userSub", "clinicId", "accessLevel"] },
                timestamp: new Date().toISOString()
            });
        }

        if (!VALID_ACCESS_LEVELS.includes(accessLevel)) {
            console.warn(`[VALIDATION] Invalid access level provided: ${accessLevel}`);
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
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
            statusCode: 200,
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
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to assign user to clinic",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};