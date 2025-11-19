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

// Assuming 'utils' is in the same directory or accessible path
// You will need to create a TypeScript type definition for validateToken
// Example: type ValidateToken = (event: any) => Promise<string | null>;
const { validateToken } = require("./utils"); // ✅ Import your token utility

// --- AWS SDK Clients Initialization ---
// Ensure process.env.REGION is defined, e.g., 'us-east-1'
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.REGION });
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

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
export const handler = async (event: any): Promise<any> => {
    try {
        // ✅ Get userSub using shared token validator
        // Assuming validateToken returns the userSub string or null/undefined
        const userSub: string | null = await validateToken(event);
        if (!userSub) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "UserSub is required" })
            };
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
        const assignmentItems: UserClinicAssignmentItem[] = (assignments.Items as UserClinicAssignmentItem[] | undefined) || [];

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

        return {
            statusCode: 200,
            body: JSON.stringify({
                status: "success",
                message: "Account deleted successfully"
            })
        };

    } catch (error: any) { // Catch block should type the error for better handling
        console.error("Error deleting account:", error);
        return {
            statusCode: 400,
            body: JSON.stringify({
                error: `Failed to delete account: ${error.message}`
            })
        };
    }
};