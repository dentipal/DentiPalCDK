import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
// Assuming 'isRoot' is defined in a separate file named 'utils.ts'
import { isRoot } from './utils';

// --- Initialization ---

/**
 * DynamoDBClient instance using the AWS SDK v3.
 * It reads the region from the environment variables.
 */
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

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
    try {
        // 1. Authorization Check (Root User)
        // Extract Cognito groups from the Authorizer claims
        const groupsString = event.requestContext.authorizer?.claims?.['cognito:groups'];
        const groups = typeof groupsString === 'string' ? groupsString.split(',') : [];

        if (!isRoot(groups)) {
            console.warn(`[AUTH] User groups [${groups.join(',')}] is not a Root user. Access denied.`);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "Only Root users can assign clinics" })
            };
        }

        // 2. Input Validation
        const { userSub, clinicId, accessLevel } = JSON.parse(event.body || '{}') as AssignClinicRequestBody;

        if (!userSub || !clinicId || !accessLevel) {
            console.warn("[VALIDATION] Missing required fields: userSub, clinicId, or accessLevel.");
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Missing required fields" })
            };
        }

        if (!VALID_ACCESS_LEVELS.includes(accessLevel)) {
            console.warn(`[VALIDATION] Invalid access level provided: ${accessLevel}`);
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Invalid access level" })
            };
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
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "User assigned to clinic successfully" }),
        };

    } catch (error) {
        // Use type assertion for better error logging
        const err = error as Error;
        console.error("Error assigning user to clinic:", err);
        return {
            statusCode: 500, // Changed from 400 to 500 for general server errors
            body: JSON.stringify({ error: `Failed to assign user: ${err.message}` })
        };
    }
};

// Note: The original file had the exports at the end, which is standard for compiled JS.
// In TypeScript, using 'export const handler' at the function definition is typical.