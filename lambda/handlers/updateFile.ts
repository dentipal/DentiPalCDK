import {
    DynamoDBClient,
    UpdateItemCommand,
    UpdateItemCommandInput,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";

// Initialize DynamoDB Client
const client = new DynamoDBClient({ region: process.env.REGION });
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE!;

// CORS Headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,PUT"
};

interface UpdateFileBody {
    objectKey: string; // The S3 key of the uploaded file
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // 1. Handle CORS Preflight
    // Cast to any to handle both V1 and V2 requestContext structures safely
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication
        const userSub = await validateToken(event as any);
        
        // 3. Parse Body
        if (!event.body) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Request body is required" })
            };
        }
        const body: UpdateFileBody = JSON.parse(event.body);
        if (!body.objectKey) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "objectKey is required" })
            };
        }

        // 4. Determine Update Target based on Path
        const path = event.path || (event as any).rawPath || "";
        let updateExpression = "";
        let attributeValues: Record<string, AttributeValue> = {};

        if (path.includes("profile-image") || path.includes("profile-images")) {
            updateExpression = "SET profileImageKey = :key, updatedAt = :ts";
            attributeValues = {
                ":key": { S: body.objectKey },
                ":ts": { S: new Date().toISOString() }
            };
        } else if (path.includes("certificate") || path.includes("certificates")) {
            // For certificates, we might append to a list or set
            // Here we assume appending to a list 'certificateKeys'
            updateExpression = "SET certificateKeys = list_append(if_not_exists(certificateKeys, :empty_list), :key), updatedAt = :ts";
            attributeValues = {
                ":key": { L: [{ S: body.objectKey }] },
                ":empty_list": { L: [] },
                ":ts": { S: new Date().toISOString() }
            };
        } else if (path.includes("video-resume") || path.includes("video-resumes")) {
            updateExpression = "SET videoResumeKey = :key, updatedAt = :ts";
            attributeValues = {
                ":key": { S: body.objectKey },
                ":ts": { S: new Date().toISOString() }
            };
        } else {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Invalid file update path" })
            };
        }

        // 5. Update DynamoDB
        const params: UpdateItemCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: attributeValues,
            ReturnValues: "UPDATED_NEW"
        };

        await client.send(new UpdateItemCommand(params));

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({ 
                message: "File metadata updated successfully", 
                objectKey: body.objectKey 
            })
        };

    } catch (error) {
        console.error("Error updating file metadata:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: (error as Error).message || "Internal Server Error" })
        };
    }
};