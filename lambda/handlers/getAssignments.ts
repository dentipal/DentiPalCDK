// index.ts
import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { isRoot } from "./utils"; 

// Initialize DynamoDB client (AWS SDK v3)
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define interfaces for type safety

// Simplified type for a raw DynamoDB item
interface DynamoDBAssignmentItem {
    userSub: AttributeValue;
    clinicId: AttributeValue;
    accessLevel: AttributeValue;
    assignedAt: AttributeValue;
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

// Define common headers (assuming no CORS helper logic needed, as in original)
const HEADERS = {
    "Content-Type": "application/json",
};

/**
 * AWS Lambda handler to retrieve clinic assignments for the authenticated user, 
 * or for a target user if the caller is a Root user.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Extract User/Auth Info
        // Assumes Cognito Authorizer is used and populates claims
        const userSub: string = (event.requestContext.authorizer as any)?.claims?.sub;
        const groupsRaw = (event.requestContext.authorizer as any)?.claims['cognito:groups'];
        
        const groups: string[] = (typeof groupsRaw === 'string' ? groupsRaw.split(',') : [])
            .map(s => s.trim())
            .filter(Boolean);

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
        const assignments: AssignmentResponseItem[] = (response.Items as DynamoDBAssignmentItem[] || []).map(item => ({
            // Safely unwrap AttributeValue string types
            userSub: item.userSub.S || '',
            clinicId: item.clinicId.S || '',
            accessLevel: item.accessLevel.S || '',
            assignedAt: item.assignedAt.S || '',
        }));

        // 5. Success Response
        return {
            statusCode: 200,
            headers: { ...HEADERS, "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ status: "success", assignments }),
        };
    }
    catch (error: any) {
        // 6. Error Response
        console.error("Error retrieving assignments:", error);
        return { 
            statusCode: 400, 
            headers: { ...HEADERS, "Access-Control-Allow-Origin": "*" },
            body: JSON.stringify({ error: `Failed to retrieve assignments: ${error.message}` }) 
        };
    }
};