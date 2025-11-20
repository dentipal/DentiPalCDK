import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { isRoot } from './utils'; // Assumed dependency

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define expected request body structure
interface DeleteAssignmentRequestBody {
    userSub: string;
    clinicId: string;
}

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization Check (Root User Only)
        // Extract groups from the Authorizer claims
        const groupsString = event.requestContext.authorizer?.claims?.['cognito:groups'];
        // Note: The groups in the claims might be comma-separated strings or arrays, splitting covers common cases.
        const groups: string[] = typeof groupsString === 'string' ? groupsString.split(',') : [];

        // Use the imported utility function to check for Root group membership
        if (!isRoot(groups)) {
            console.warn(`[AUTH] User groups [${groups.join(', ')}] is not Root. Access denied.`);
            return {
                statusCode: 403,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Only Root users can delete assignments" })
            };
        }

        // 2. Input Parsing and Validation
        const { userSub, clinicId } = JSON.parse(event.body || '{}') as DeleteAssignmentRequestBody;

        if (!userSub || !clinicId) {
            console.warn("[VALIDATION] Missing required fields: userSub or clinicId.");
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Missing required fields" })
            };
        }

        console.log(`[DB] Attempting to delete assignment for userSub: ${userSub} and clinicId: ${clinicId}`);

        // 3. DynamoDB Delete Operation
        // Assuming the composite primary key for the assignments table is (userSub, clinicId)
        const command = new DeleteItemCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE, // Environment variable for table name
            Key: {
                userSub: { S: userSub },
                clinicId: { S: clinicId },
            },
        });

        await dynamoClient.send(command);

        // 4. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Added headers
            body: JSON.stringify({ status: "success", message: "Assignment deleted successfully" }),
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting assignment:", err);
        
        // Use 500 for unexpected errors, preserving the error message detail
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Added headers
            body: JSON.stringify({ error: `Failed to delete assignment: ${err.message}` })
        };
    }
};