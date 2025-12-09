import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils";
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

// Generic update implementation — updates the professional profile record for a given userSub
const updateFileForType = async (event: APIGatewayProxyEvent, fileType: string): Promise<APIGatewayProxyResult> => {
    console.info(`🔧 Starting updateFileMetadata handler for ${fileType}`);

    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "POST";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- Authentication ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // Parse Body
        if (!event.body) return json(400, { error: "Request body is required" });
        let body: UpdateFileBody;
        try { body = JSON.parse(event.body); } catch (e) { return json(400, { error: "Invalid JSON format" }); }
        if (!body.objectKey) return json(400, { error: "objectKey is required" });

        // Build update expression depending on fileType
        const now = new Date().toISOString();
        let updateExpression = "";
        let expressionAttributeValues: Record<string, any> = {};

        switch (fileType) {
            case "profile-image":
                updateExpression = "SET profileImageKey = :key, updatedAt = :ts";
                expressionAttributeValues = { ":key": body.objectKey, ":ts": now };
                break;
            case "professional-resume":
                // append to list resumeKeys
                updateExpression = "SET professionalResumeKeys = list_append(if_not_exists(professionalResumeKeys, :empty_list), :key), updatedAt = :ts";
                expressionAttributeValues = { ":key": [body.objectKey], ":empty_list": [], ":ts": now };
                break;
            case "professional-license":
                updateExpression = "SET professionalLicenseKeys = list_append(if_not_exists(professionalLicenseKeys, :empty_list), :key), updatedAt = :ts";
                expressionAttributeValues = { ":key": [body.objectKey], ":empty_list": [], ":ts": now };
                break;
            case "driving-license":
                updateExpression = "SET drivingLicenseKeys = list_append(if_not_exists(drivingLicenseKeys, :empty_list), :key), updatedAt = :ts";
                expressionAttributeValues = { ":key": [body.objectKey], ":empty_list": [], ":ts": now };
                break;
            case "video-resume":
                updateExpression = "SET videoResumeKey = :key, updatedAt = :ts";
                expressionAttributeValues = { ":key": body.objectKey, ":ts": now };
                break;
            default:
                return json(400, { error: "Unsupported fileType for update" });
        }

        const params: UpdateCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: userSub },
            UpdateExpression: updateExpression,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "UPDATED_NEW"
        };

        const result = await ddbDoc.send(new UpdateCommand(params));

        return json(200, { message: "File metadata updated successfully", objectKey: body.objectKey, updatedAttributes: result.Attributes });

    } catch (error: any) {
        console.error("Error updating file metadata:", error);
        if (error.message === "Authorization header missing" || error.message?.startsWith("Invalid authorization header") || error.message === "Invalid access token format" || error.message === "Failed to decode access token") {
            return json(401, { error: "Unauthorized", details: error.message });
        }
        return json(500, { error: error.message || "Internal Server Error" });
    }
};

// Export specific handlers for each file type
export const updateProfileImage = async (event: APIGatewayProxyEvent) => updateFileForType(event, "profile-image");
export const updateProfessionalResume = async (event: APIGatewayProxyEvent) => updateFileForType(event, "professional-resume");
export const updateProfessionalLicense = async (event: APIGatewayProxyEvent) => updateFileForType(event, "professional-license");
export const updateDrivingLicense = async (event: APIGatewayProxyEvent) => updateFileForType(event, "driving-license");
export const updateVideoResume = async (event: APIGatewayProxyEvent) => updateFileForType(event, "video-resume");

// Keep default handler for backward compatibility
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Try to infer file type from path and dispatch
    const path = event.path || (event as any).rawPath || "";
    if (path.includes("profile-image") || path.includes("profile-images")) return updateProfileImage(event);
    if (path.includes("certificate") || path.includes("certificates")) return updateProfessionalLicense(event);
    if (path.includes("video-resume") || path.includes("video-resumes")) return updateVideoResume(event);
    return json(400, { error: "Invalid file update path. Use /profile-image, /certificates, or /video-resume." });
};