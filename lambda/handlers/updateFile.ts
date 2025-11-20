import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || "us-east-1";
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;

// Initialize V3 Client and Document Client
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 3. Type Definitions ---

interface UpdateFileBody {
    objectKey: string; // The S3 key of the uploaded file
    [key: string]: any;
}

// --- 4. Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🔧 Starting updateFileMetadata handler");

    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication
        // validateToken returns the userSub string
        const userSub = await validateToken(event);
        
        // 3. Parse Body
        if (!event.body) {
            return json(400, { error: "Request body is required" });
        }

        let body: UpdateFileBody;
        try {
            body = JSON.parse(event.body);
        } catch (e) {
            return json(400, { error: "Invalid JSON format" });
        }

        if (!body.objectKey) {
            return json(400, { error: "objectKey is required" });
        }

        // 4. Determine Update Target based on Path
        const path = event.path || (event as any).rawPath || "";
        let updateExpression = "";
        let expressionAttributeValues: Record<string, any> = {};

        // Timestamps
        const now = new Date().toISOString();

        if (path.includes("profile-image") || path.includes("profile-images")) {
            updateExpression = "SET profileImageKey = :key, updatedAt = :ts";
            expressionAttributeValues = {
                ":key": body.objectKey,
                ":ts": now
            };
        } else if (path.includes("certificate") || path.includes("certificates")) {
            // Append to list 'certificateKeys'
            // Note: We wrap body.objectKey in an array because list_append expects two lists
            updateExpression = "SET certificateKeys = list_append(if_not_exists(certificateKeys, :empty_list), :key), updatedAt = :ts";
            expressionAttributeValues = {
                ":key": [body.objectKey], 
                ":empty_list": [],
                ":ts": now
            };
        } else if (path.includes("video-resume") || path.includes("video-resumes")) {
            updateExpression = "SET videoResumeKey = :key, updatedAt = :ts";
            expressionAttributeValues = {
                ":key": body.objectKey,
                ":ts": now
            };
        } else {
            return json(400, { error: "Invalid file update path. Use /profile-image, /certificates, or /video-resume." });
        }

        // 5. Update DynamoDB
        const params: UpdateCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: userSub }, 
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "UPDATED_NEW"
        };

        const result = await ddbDoc.send(new UpdateCommand(params));

        return json(200, { 
            message: "File metadata updated successfully", 
            objectKey: body.objectKey,
            updatedAttributes: result.Attributes
        });

    } catch (error) {
        console.error("Error updating file metadata:", error);
        return json(500, { error: (error as Error).message || "Internal Server Error" });
    }
};