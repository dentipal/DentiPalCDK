import {
    AdminDeleteUserCommand,
    CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
    DynamoDBClient,
    QueryCommand,
    DeleteItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";
// Import validation utility
import { validateToken } from "./utils";

// --- AWS SDK Clients Initialization ---
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the structure of an item returned from the DynamoDB Query for type safety
interface UserClinicAssignmentItem {
    userSub?: { S: string };
    clinicId?: { S: string };
    [key: string]: AttributeValue | undefined; // Allow other DynamoDB fields
}

/**
 * AWS Lambda handler to delete a user account from Cognito and remove
 * their clinic assignments from DynamoDB.
 * @param event The Lambda event (e.g., API Gateway event containing auth token).
 * @returns An API Gateway-compatible response object.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // ✅ Get userSub using shared token validator
        // Cast event to 'any' to match the signature expected by validateToken if strictly typed elsewhere
        const userSub: string = await validateToken(event as any);
        
        if (!userSub) {
            return json(400, { error: "UserSub is required" });
        }

        // 🧹 Clean up clinic assignments
        const cleanupCommand = new QueryCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE, // Ensure this env var is set
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": { S: userSub }
            }
        });

        // Use a type assertion to help TypeScript understand the structure of the returned items
        const assignments = await dynamoClient.send(cleanupCommand);
        const assignmentItems = (assignments.Items as UserClinicAssignmentItem[] | undefined) || [];

        for (const item of assignmentItems) {
            if (item.clinicId?.S) {
                await dynamoClient.send(new DeleteItemCommand({
                    TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
                    Key: {
                        userSub: { S: userSub },
                        clinicId: { S: item.clinicId.S }
                    }
                }));
            }
        }

        // ❌ Stop using accessToken
        // ✅ Use AdminDeleteUserCommand with userSub
        await cognitoClient.send(new AdminDeleteUserCommand({
            UserPoolId: process.env.USER_POOL_ID, // Ensure this env var is set
            Username: userSub // The 'Username' in Cognito for AdminDeleteUser is the userSub/UUID
        }));

        return json(200, {
            status: "success",
            message: "Account deleted successfully"
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting account:", err);
        return json(500, {
            error: `Failed to delete account: ${err.message}`
        });
    }
};