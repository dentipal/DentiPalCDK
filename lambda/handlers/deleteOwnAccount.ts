import {
    AdminDeleteUserCommand,
    CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, QueryCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";

// --- AWS SDK Clients Initialization ---
const REGION = process.env.REGION || "us-east-1";
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

interface UserClinicAssignmentItem {
    userSub?: string;
    clinicId?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication (Access Token)
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }

        const assignmentsTable = process.env.USER_CLINIC_ASSIGNMENTS_TABLE;
        if (!assignmentsTable) {
            return json(500, { error: "Server error: USER_CLINIC_ASSIGNMENTS_TABLE not defined" });
        }

        // 2. Clean up clinic assignments
        // Query finding all assignments for this user
        const cleanupCommand = new QueryCommand({
            TableName: assignmentsTable,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": userSub
            }
        });

        const assignments = await ddbDoc.send(cleanupCommand);
        const assignmentItems = (assignments.Items as UserClinicAssignmentItem[]) || [];

        // Delete each assignment found
        for (const item of assignmentItems) {
            if (item.clinicId) {
                await ddbDoc.send(new DeleteCommand({
                    TableName: assignmentsTable,
                    Key: {
                        userSub: userSub,
                        clinicId: item.clinicId
                    }
                }));
            }
        }

        // 3. Delete User from Cognito
        await cognitoClient.send(new AdminDeleteUserCommand({
            UserPoolId: process.env.USER_POOL_ID, 
            Username: userSub 
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