import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken, isRoot } from "./utils";
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
        // 1. Authentication & Authorization Check (Root User)
        await validateToken(event);

        const groupsString: string | undefined = event.requestContext.authorizer?.claims?.['cognito:groups'];
        const groups: string[] = groupsString?.split(',') || [];
        
        if (!isRoot(groups)) {
            return json(403, { error: "Only Root users can update assignments" });
        }

        if (!event.body) {
             return json(400, { error: "Missing request body" });
        }
        
        // 2. Parse and Validate Body
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

        // 3. Update DynamoDB Item
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

        // 4. Success Response
        return json(200, { status: "success", message: "Assignment updated successfully" });

    } catch (err) {
        const error = err as Error;
        console.error("Error updating assignment:", error);
        
        // Check for specific DynamoDB error if needed (e.g., ConditionalCheckFailedException from the ConditionExpression)
        if (error.name === "ConditionalCheckFailedException") {
             return json(404, { error: "The assignment to be updated was not found." });
        }

        return json(500, { error: `Failed to update assignment: ${error.message}` });
    }
};