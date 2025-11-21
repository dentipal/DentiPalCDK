import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- Initialization ---
const REGION = process.env.REGION || "us-east-1";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";

// Initialize Document Client
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- Helpers ---
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const normalizeGroup = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🗑️ Starting deleteClinicAccountHandler");

    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication (Access Token)
        let userSub: string;
        let userGroups: string[] = [];
        let userType: string = "";

        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
            userType = userInfo.userType || "";
        } catch (authError: any) {
            console.error("Auth Error:", authError.message);
            return json(401, { 
                error: "Unauthorized", 
                message: authError.message || "Invalid access token" 
            });
        }

        // 3. Authorization Check
        // Normalize groups for case-insensitive comparison
        const normalizedGroups = userGroups.map(normalizeGroup);
        
        // Must be 'clinic' type, in 'clinic' group, or 'root'
        const isClinicUser = userType.toLowerCase() === "clinic" || normalizedGroups.some(g => g.includes("clinic"));
        const isRootUser = normalizedGroups.includes("root");

        if (!isClinicUser && !isRootUser) {
            console.warn(`❌ User ${userSub} denied access. Type: ${userType}, Groups: ${userGroups.join(', ')}`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied",
                details: { requiredUserTypes: ["clinic", "root"] }
            });
        }

        // 4. Extract clinicId
        const pathParts = event.path?.split("/").filter(Boolean) || [];
        // Robustly find the ID: usually the last segment or the one after 'clinic-profiles'
        const clinicId = event.pathParameters?.clinicId || pathParts[pathParts.length - 1];

        if (!clinicId || clinicId === 'clinic' || clinicId === 'profile') {
            return json(400, {
                error: "Bad Request",
                message: "Clinic ID is required in path",
                details: { pathFormat: "/clinic-profiles/{clinicId}" }
            });
        }

        console.info("📌 Deleting clinicId:", clinicId, "| userSub:", userSub);

        // 5. Check Existence
        // Use GetCommand (Document Client) - no { S: ... } needed
        const getCommand = new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { 
                clinicId: clinicId, 
                userSub: userSub 
            }
        });

        const existing = await ddbDoc.send(getCommand);

        if (!existing.Item) {
            return json(404, {
                error: "Not Found",
                message: "Clinic profile not found",
                details: { clinicId }
            });
        }

        // 6. Delete Profile
        const deleteCommand = new DeleteCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { 
                clinicId: clinicId, 
                userSub: userSub 
            }
        });

        await ddbDoc.send(deleteCommand);
        console.info(`✅ Clinic account deleted for clinicId: ${clinicId}, userSub: ${userSub}`);

        return json(200, {
            status: "success",
            message: "Clinic profile deleted successfully",
            data: {
                clinicId,
                deletedAt: new Date().toISOString()
            }
        });

    } catch (error) {
        const err = error as Error;
        console.error("🔥 Error deleting clinic account:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to delete clinic profile",
            details: { reason: err.message }
        });
    }
};