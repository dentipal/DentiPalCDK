import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    PutItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { extractUserFromBearerToken } from "./utils";
import { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } from "./professionalRoles";
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Interface for the expected request body data structure
interface ProfessionalProfileData {
    role: string;
    first_name: string;
    last_name: string;
    specialties?: string[]; 
    [key: string]: any;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle method extraction for both REST (v1) and HTTP (v2) APIs
    const method = (event.requestContext as any).http?.method || event.httpMethod || "POST";

    // --- CORS preflight ---
    if (method === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization - Extract access token
        let userSub: string;
        try {
            // Check both capitalized and lowercase Authorization header
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            if (!authHeader) {
                throw new Error("Authorization header is missing");
            }
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            console.error("Authorization error:", authError);
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: authError.message || "Invalid access token",
                }),
            };
        }

        // 2. Parse and validate request body (FIXED)
        let profileData: ProfessionalProfileData;
        try {
            let bodyString = event.body;

            // FIX: Handle Base64 encoding from API Gateway
            if (event.isBase64Encoded && bodyString) {
                bodyString = Buffer.from(bodyString, 'base64').toString('utf-8');
            }

            const parsedBody = JSON.parse(bodyString || '{}');

            // FIX: Handle mismatch between camelCase (frontend) and snake_case (backend)
            // If first_name is missing but firstName exists, use firstName.
            profileData = {
                ...parsedBody,
                first_name: parsedBody.first_name || parsedBody.firstName || "",
                last_name: parsedBody.last_name || parsedBody.lastName || "",
                role: parsedBody.role || ""
            };

        } catch (parseError) {
            console.error("Error parsing request body:", parseError);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Invalid JSON in request body",
                }),
            };
        }

        console.log("Processed profile data:", profileData);

        // 3. Validate required fields
        const missingFields = [];
        if (!profileData.first_name || profileData.first_name.trim() === "") missingFields.push("first_name");
        if (!profileData.last_name || profileData.last_name.trim() === "") missingFields.push("last_name");
        if (!profileData.role || profileData.role.trim() === "") missingFields.push("role");

        if (missingFields.length > 0) {
            console.warn("[VALIDATION] Missing or empty required fields:", missingFields);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Required fields are missing or empty",
                    details: { missingFields, received: profileData }, // Added 'received' for easier debugging
                }),
            };
        }

        // 4. Validate professional role
        if (!VALID_ROLE_VALUES.includes(profileData.role)) {
            console.warn(`[VALIDATION] Invalid role provided: ${profileData.role}`);
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: `Invalid role. Valid options: ${VALID_ROLE_VALUES.map(
                        (role) => DB_TO_DISPLAY_MAPPING[role] || role
                    ).join(", ")}`,
                }),
            };
        }

        const timestamp = new Date().toISOString();

        // 5. Build DynamoDB item
        const item: Record<string, AttributeValue> = {
            userSub: { S: userSub }, // Primary Key
            role: { S: profileData.role },
            first_name: { S: profileData.first_name },
            last_name: { S: profileData.last_name },
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
        };

        // 6. Add optional dynamic fields
        Object.entries(profileData).forEach(([key, value]) => {
            // Exclude keys we already handled or mapped manually
            const excludeKeys = ["role", "first_name", "last_name", "firstName", "lastName", "specialties"];
            
            if (!excludeKeys.includes(key) && value !== undefined && value !== null) {
                if (typeof value === "string") {
                    item[key] = { S: value };
                } else if (typeof value === "boolean") {
                    item[key] = { BOOL: value };
                } else if (typeof value === "number") {
                    item[key] = { N: value.toString() };
                } else if (Array.isArray(value)) {
                    const stringArray = value.filter(v => typeof v === 'string') as string[];
                    item[key] = { SS: stringArray.length > 0 ? stringArray : [""] };
                }
            }
        });

        // 7. Special handling for specialties
        if (profileData.specialties && Array.isArray(profileData.specialties)) {
            const specialtiesArray = profileData.specialties.filter(s => typeof s === 'string') as string[];
            item.specialties = { SS: specialtiesArray.length > 0 ? specialtiesArray : [""] };
        }

        // 8. Insert into DynamoDB
        await dynamodb.send(
            new PutItemCommand({
                TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                Item: item,
                ConditionExpression: "attribute_not_exists(userSub)",
            })
        );

        // 9. Success Response
        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Professional profile created successfully",
                userSub,
                role: profileData.role,
                first_name: profileData.first_name,
                last_name: profileData.last_name,
            }),
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error creating professional profile:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 409,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Professional profile already exists for this user",
                }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: err.message || "An unexpected error occurred" }),
        };
    }
};