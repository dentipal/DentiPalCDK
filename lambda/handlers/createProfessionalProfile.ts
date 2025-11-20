import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    PutItemCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils"; 
import { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } from "./professionalRoles"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Interface for the expected request body data structure
interface ProfessionalProfileData {
    role: string;
    first_name: string;
    last_name: string;
    specialties?: string[]; // Specifically handled
    // Allow for other dynamic string/boolean/number/array fields
    [key: string]: any;
}


// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to handle both REST API (v1) and HTTP API (v2) events
    // APIGatewayProxyEvent definition strictly checks for v1 properties.
    const method =
        (event.requestContext as any).http?.method || event.httpMethod || "POST";

    // --- CORS preflight ---
    if (method === "OPTIONS") {
        // ✅ Uses imported headers
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization and Parsing
        const userSub: string = await validateToken(event);
        const profileData: ProfessionalProfileData = JSON.parse(event.body || '{}');

        // 2. Validate required fields
        if (!profileData.first_name || !profileData.last_name || !profileData.role) {
            console.warn("[VALIDATION] Missing required fields: first_name, last_name, or role.");
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "role, first_name, and last_name are required",
                }),
            };
        }

        // 3. Validate professional role
        if (!VALID_ROLE_VALUES.includes(profileData.role)) {
            console.warn(`[VALIDATION] Invalid role provided: ${profileData.role}`);
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: `Invalid role. Valid options: ${VALID_ROLE_VALUES.map(
                        (role) => DB_TO_DISPLAY_MAPPING[role] || role
                    ).join(", ")}`,
                }),
            };
        }

        const timestamp = new Date().toISOString();

        // 4. Build DynamoDB item using standard Record<string, AttributeValue>
        const item: Record<string, AttributeValue> = {
            userSub: { S: userSub }, // Primary Key
            role: { S: profileData.role },
            first_name: { S: profileData.first_name },
            last_name: { S: profileData.last_name },
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
        };

        // 5. Add optional dynamic fields
        Object.entries(profileData).forEach(([key, value]) => {
            // Skip base fields and specialties (handled separately)
            if (
                key !== "role" &&
                key !== "first_name" &&
                key !== "last_name" &&
                key !== "specialties" &&
                value !== undefined
            ) {
                if (typeof value === "string") {
                    item[key] = { S: value };
                } else if (typeof value === "boolean") {
                    item[key] = { BOOL: value };
                } else if (typeof value === "number") {
                    item[key] = { N: value.toString() };
                } else if (Array.isArray(value)) {
                    // Treating generic arrays as String Sets (SS)
                    const stringArray = value.filter(v => typeof v === 'string') as string[];
                    // Match original logic: store [""] if array is empty
                    item[key] = { SS: stringArray.length > 0 ? stringArray : [""] };
                }
            }
        });

        // 6. Special handling for specialties (as String Set)
        if (profileData.specialties && Array.isArray(profileData.specialties)) {
            const specialtiesArray = profileData.specialties.filter(s => typeof s === 'string') as string[];
            item.specialties = { SS: specialtiesArray.length > 0 ? specialtiesArray : [""] };
        }

        // 7. Insert into DynamoDB with ConditionExpression to prevent overwrites
        await dynamodb.send(
            new PutItemCommand({
                TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                Item: item,
                // Only create the profile if a userSub does not already exist
                ConditionExpression: "attribute_not_exists(userSub)",
            })
        );

        // 8. Success Response
        return {
            statusCode: 201,
            headers: CORS_HEADERS, // ✅ Uses imported headers
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
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "Professional profile already exists for this user",
                }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({ error: err.message || "An unexpected error occurred" }),
        };
    }
};