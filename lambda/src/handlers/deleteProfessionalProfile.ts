import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // 1. Authentication
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(event, 401, { 
                error: "Unauthorized", 
                message: "Invalid or expired token", 
                details: { issue: authError.message } 
            });
        }

        const tableName = process.env.PROFESSIONAL_PROFILES_TABLE;
        if (!tableName) return json(event, 500, { error: "Server configuration error" });

        // 2. Check if the user has a profile
        const getCommand = new GetCommand({
            TableName: tableName,
            Key: { userSub: userSub },
        });
        const existingProfile = await ddbDoc.send(getCommand);

        if (!existingProfile.Item) {
            return json(event, 404, {
                error: "Not Found",
                message: "Professional profile not found",
                details: { userSub }
            });
        }

        // 3. Check if default profile
        const isDefault = existingProfile.Item.isDefault === true || existingProfile.Item.isDefault === "true";

        if (isDefault) {
            return json(event, 409, {
                error: "Conflict",
                message: "Cannot delete default profile",
                details: { reason: "Set another profile as default first" }
            });
        }

        // 4. Delete the profile
        const deleteCommand = new DeleteCommand({
            TableName: tableName,
            Key: { userSub: userSub },
        });
        await ddbDoc.send(deleteCommand);

        // 5. Success
        return json(event, 200, {
            status: "success",
            message: "Professional profile deleted successfully",
            data: {
                deletedUserSub: userSub,
                deletedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error deleting professional profile:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            message: "Failed to delete professional profile",
            details: { reason: err.message }
        });
    }
};