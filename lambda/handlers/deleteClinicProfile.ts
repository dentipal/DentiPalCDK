import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
    DynamoDBClient, 
    GetItemCommand, 
    DeleteItemCommand,
    AttributeValue 
} from "@aws-sdk/client-dynamodb";
import { Buffer } from 'buffer'; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Interface for the claims expected in the decoded JWT payload
interface Claims {
    sub: string;
    'cognito:groups'?: string[] | string;
    'custom:user_type'?: string;
    [key: string]: any; // Allow for other claims
}

// --- Initialization ---

// Initialize Document Client using AWS SDK v3
const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;

// Utility function to handle Base64 URL decoding
function b64urlToUtf8(b64url: string): string {
    // Support URL-safe base64: pad and replace characters
    const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
    const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    return Buffer.from(b64, "base64").toString("utf8");
}

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🗑️ Starting deleteClinicAccountHandler");

    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Decode JWT token manually
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.error("❌ Missing or invalid Authorization header");
            return {
                statusCode: 401,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Missing or invalid Authorization header" }),
            };
        }

        const token = authHeader.split(" ")[1];
        const tokenParts = token.split(".");
        
        if (tokenParts.length !== 3) {
             console.error("❌ Invalid JWT format");
             return {
                statusCode: 401,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Invalid token format" }),
            };
        }

        const payload = tokenParts[1];
        // Decode the payload using the utility function
        const decodedClaims: Claims = JSON.parse(b64urlToUtf8(payload));

        const userSub = decodedClaims.sub;
        // Ensure groups is an array of lowercase strings
        let groups: string[] = [];
        const rawGroups = decodedClaims["cognito:groups"] || [];
        if (Array.isArray(rawGroups)) {
            groups = rawGroups.map((g: string) => g.toLowerCase());
        } else if (typeof rawGroups === 'string') {
            groups = rawGroups.split(',').map(g => g.trim().toLowerCase());
        }

        const userType = (decodedClaims["custom:user_type"] || "professional").toLowerCase();

        console.info("📦 Decoded claims:", decodedClaims);

        if (!userSub) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Missing userSub in token" }),
            };
        }

        // Authorization check: Must be a clinic user (either via userType or group) OR a root user.
        const isClinicUser = userType === "clinic" || groups.includes("clinic");
        const isRootUser = groups.includes("root");
        
        if (!isClinicUser && !isRootUser) {
            console.warn(`❌ User ${userSub} denied access. Type: ${userType}, Groups: ${groups.join(', ')}`);
            return {
                statusCode: 403,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({
                    error: "Access denied – only clinic or root users can delete a clinic profile",
                }),
            };
        }

        // Step 2: Extract clinicId from URL path (assuming /path/to/clinicId)
        const pathParts = event.path?.split("/") || [];
        const clinicId = pathParts[pathParts.length - 1];

        if (!clinicId || clinicId === 'clinic') { // Basic check for potentially incomplete path
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Missing or invalid clinicId in path" }),
            };
        }

        console.info("📌 Deleting clinicId:", clinicId, "| userSub:", userSub);

        // Step 3: Check existence (Standard Client GetItemCommand)
        const getParams = {
            TableName: CLINIC_PROFILES_TABLE,
            // FIX: Use explicit AttributeValue syntax { S: value }
            Key: { 
                clinicId: { S: clinicId }, 
                userSub: { S: userSub } 
            },
        };

        const existing = await dynamodb.send(new GetItemCommand(getParams));

        if (!existing.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, // ✅ Added headers
                body: JSON.stringify({ error: "Clinic profile not found" }),
            };
        }

        // Step 4: Delete profile (Standard Client DeleteItemCommand)
        const deleteParams = {
            TableName: CLINIC_PROFILES_TABLE,
            // FIX: Use explicit AttributeValue syntax { S: value }
            Key: { 
                clinicId: { S: clinicId }, 
                userSub: { S: userSub } 
            },
        };

        await dynamodb.send(new DeleteItemCommand(deleteParams));
        console.info(`✅ Clinic account deleted for clinicId: ${clinicId}, userSub: ${userSub}`);

        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Added headers
            body: JSON.stringify({
                message: "Clinic profile deleted successfully",
                clinicId,
                deletedAt: new Date().toISOString(),
            }),
        };
    } catch (error) {
        const err = error as Error;
        console.error("🔥 Error deleting clinic account:", err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Added headers
            body: JSON.stringify({ error: err.message || "Failed to delete clinic account" }),
        };
    }
};