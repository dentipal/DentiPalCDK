import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDBClient, DeleteItemCommand } from '@aws-sdk/client-dynamodb';
import { isRoot, extractUserFromBearerToken } from './utils'; // Assumed dependency

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
        // Extract Bearer token from Authorization header
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const groups = userInfo.groups;

        // Use the imported utility function to check for Root group membership
        if (!isRoot(groups)) {
            console.warn(`[AUTH] User groups [${groups.join(', ')}] is not Root. Access denied.`);
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Forbidden",
                    statusCode: 403,
                    message: "Only Root users can delete assignments",
                    details: { requiredGroup: "Root" },
                    timestamp: new Date().toISOString()
                })
            };
        }

        // 2. Input Parsing and Validation
        const { userSub, clinicId } = JSON.parse(event.body || '{}') as DeleteAssignmentRequestBody;

        if (!userSub || !clinicId) {
            console.warn("[VALIDATION] Missing required fields: userSub or clinicId.");
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Required fields are missing",
                    details: { missingFields: [!userSub && "userSub", !clinicId && "clinicId"].filter(Boolean) },
                    timestamp: new Date().toISOString()
                })
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
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 200,
                message: "Assignment deleted successfully",
                data: { deletedUserSub: userSub, deletedClinicId: clinicId },
                timestamp: new Date().toISOString()
            }),
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting assignment:", err);
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Internal Server Error",
                statusCode: 500,
                message: "Failed to delete assignment",
                details: { reason: err.message },
                timestamp: new Date().toISOString()
            })
        };
    }
};