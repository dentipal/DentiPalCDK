import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { isRoot } from "./utils";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

/** Defines the structure of the request body for the assignment update */
interface UpdateAssignmentBody {
    userSub?: string;
    clinicId?: string;
    accessLevel?: string;
}

// --- Environment & Clients ---

const REGION: string = process.env.REGION || "us-east-1";
const USER_CLINIC_ASSIGNMENTS_TABLE: string | undefined = process.env.USER_CLINIC_ASSIGNMENTS_TABLE;

const dynamoClient = new DynamoDBClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

// --- Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userGroups = userInfo.groups || [];

        // 2. Authorization Check (Root User)
        if (!isRoot(userGroups)) {
            return json(403, { error: "Only Root users can update assignments" });
        }

        if (!event.body) {
             return json(400, { error: "Missing request body" });
        }
        
        // 3. Parse and Validate Body
        const { userSub, clinicId, accessLevel }: UpdateAssignmentBody = JSON.parse(event.body);
        
        if (!userSub || !clinicId || !accessLevel) {
            return json(400, { error: "Missing required fields (userSub, clinicId, or accessLevel)" });
        }
        
        const validAccessLevels: ReadonlyArray<string> = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
        
        if (!validAccessLevels.includes(accessLevel)) {
            return json(400, { error: "Invalid access level" });
        }

        if (!USER_CLINIC_ASSIGNMENTS_TABLE) {
             console.error("Environment variable USER_CLINIC_ASSIGNMENTS_TABLE is not set.");
             return json(500, { error: "Server configuration error." });
        }

        // 4. Update DynamoDB Item
        const command = new UpdateItemCommand({
            TableName: USER_CLINIC_ASSIGNMENTS_TABLE,
            Key: { 
                userSub: { S: userSub }, 
                clinicId: { S: clinicId } 
            },
            UpdateExpression: "SET accessLevel = :accessLevel, assignedAt = :assignedAt",
            ExpressionAttributeValues: {
                ":accessLevel": { S: accessLevel },
                ":assignedAt": { S: new Date().toISOString() },
            },
            // Ensure the item exists before attempting to update it (optional, but safer)
            ConditionExpression: "attribute_exists(userSub) AND attribute_exists(clinicId)" 
        });

        await dynamoClient.send(command);

        // 5. Success Response
        return json(200, { status: "success", message: "Assignment updated successfully" });

    } catch (err) {
        const error = err as Error;
        console.error("Error updating assignment:", error);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        // Check for specific DynamoDB error if needed (e.g., ConditionalCheckFailedException from the ConditionExpression)
        if (error.name === "ConditionalCheckFailedException") {
             return json(404, { error: "The assignment to be updated was not found." });
        }

        return json(500, { error: `Failed to update assignment: ${error.message}` });
    }
};