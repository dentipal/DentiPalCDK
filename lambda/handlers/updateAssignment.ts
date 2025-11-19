import { DynamoDBClient, UpdateItemCommand } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { isRoot } from "./utils"; // Assuming utils.ts exports isRoot

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

// --- Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Authorization Check (Root User)
        const groupsString: string | undefined = event.requestContext.authorizer?.claims?.['cognito:groups'];
        const groups: string[] = groupsString?.split(',') || [];
        
        if (!isRoot(groups)) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "Only Root users can update assignments" })
            };
        }

        if (!event.body) {
             return { statusCode: 400, body: JSON.stringify({ error: "Missing request body" }) };
        }
        
        // 2. Parse and Validate Body
        const { userSub, clinicId, accessLevel }: UpdateAssignmentBody = JSON.parse(event.body);
        
        if (!userSub || !clinicId || !accessLevel) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields (userSub, clinicId, or accessLevel)" }) };
        }
        
        const validAccessLevels: ReadonlyArray<string> = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
        
        if (!validAccessLevels.includes(accessLevel)) {
            return { statusCode: 400, body: JSON.stringify({ error: "Invalid access level" }) };
        }

        if (!USER_CLINIC_ASSIGNMENTS_TABLE) {
             console.error("Environment variable USER_CLINIC_ASSIGNMENTS_TABLE is not set.");
             return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error." }) };
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
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "Assignment updated successfully" }),
        };
    } catch (err) {
        const error = err as Error;
        console.error("Error updating assignment:", error);
        
        // Check for specific DynamoDB error if needed (e.g., ConditionalCheckFailedException from the ConditionExpression)
        if (error.name === "ConditionalCheckFailedException") {
             return { statusCode: 404, body: JSON.stringify({ error: "The assignment to be updated was not found." }) };
        }

        return { 
            statusCode: 500, // Changed from 400 to 500 for generic server/DB errors
            body: JSON.stringify({ error: `Failed to update assignment: ${error.message}` }) 
        };
    }
};