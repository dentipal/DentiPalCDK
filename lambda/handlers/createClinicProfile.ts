import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
    DynamoDBClient, 
    GetItemCommand, 
    PutItemCommand, 
    AttributeValue // Import this from the SDK
} from "@aws-sdk/client-dynamodb";
// Assuming validateToken is a utility function in a local file
import { validateToken } from "./utils";

// --- Type Definitions ---

// DELETE THE MANUAL INTERFACE 'AttributeValue' HERE. 
// We use the one imported from @aws-sdk/client-dynamodb instead.

// Interface for the expected request body data structure
interface ClinicProfileData {
    clinicId: string;
    practice_type: string;
    primary_practice_area: string;
    primary_contact_first_name: string;
    primary_contact_last_name: string;
    assisted_hygiene_available?: boolean;
    number_of_operatories?: number;
    num_hygienists?: number;
    num_assistants?: number;
    num_doctors?: number;
    booking_out_period?: string;
    free_parking_available?: boolean;
    [key: string]: any;
}

// Type for CORS headers
interface CorsHeaders {
    [header: string]: string;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const corsHeaders: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key",
};

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle OPTIONS (preflight) request
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }

    try {
        // 1. Authorization and Input Parsing
        const userSub: string = await validateToken(event);
        const profileData: ClinicProfileData = JSON.parse(event.body || '{}');

        // Required fields check
        if (
            !profileData.clinicId ||
            !profileData.practice_type ||
            !profileData.primary_practice_area ||
            !profileData.primary_contact_first_name ||
            !profileData.primary_contact_last_name
        ) {
            console.warn("[VALIDATION] Missing required fields in body.");
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "Required fields: clinicId, practice_type, primary_practice_area, primary_contact_first_name, primary_contact_last_name"
                })
            };
        }

        const timestamp = new Date().toISOString();

        // 2. 🔍 Check if the clinic exists and user is authorized
        const getClinicResponse = await dynamodb.send(new GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: profileData.clinicId } }
        }));

        const clinicItem = getClinicResponse.Item;

        if (!clinicItem) {
            console.warn(`[AUTH] Clinic not found: ${profileData.clinicId}`);
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Clinic not found with provided clinicId" })
            };
        }

        // Check if userSub is in the AssociatedUsers list
        const associatedUsers = clinicItem.AssociatedUsers?.L?.map(u => u.S) || [];
        if (!associatedUsers.includes(userSub)) {
            console.warn(`[AUTH] User ${userSub} is not associated with clinic ${profileData.clinicId}.`);
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({ error: "User is not authorized to create a profile for this clinic" })
            };
        }

        // 3. ✅ Build the item using Record<string, AttributeValue>
        // This ensures it matches the type expected by PutItemCommand
        const item: Record<string, AttributeValue> = {
            clinicId: { S: profileData.clinicId },
            userSub: { S: userSub },
            practice_type: { S: profileData.practice_type },
            primary_practice_area: { S: profileData.primary_practice_area },
            primary_contact_first_name: { S: profileData.primary_contact_first_name },
            primary_contact_last_name: { S: profileData.primary_contact_last_name },

            assisted_hygiene_available: { BOOL: profileData.assisted_hygiene_available ?? false },
            free_parking_available: { BOOL: profileData.free_parking_available ?? false },

            number_of_operatories: { N: (profileData.number_of_operatories ?? 0).toString() },
            num_hygienists: { N: (profileData.num_hygienists ?? 0).toString() },
            num_assistants: { N: (profileData.num_assistants ?? 0).toString() },
            num_doctors: { N: (profileData.num_doctors ?? 0).toString() },

            booking_out_period: { S: profileData.booking_out_period ?? "immediate" },

            createdAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };

        // 4. ✅ Add optional dynamic fields
        Object.entries(profileData).forEach(([key, value]) => {
            if (!item[key] && value !== undefined) {
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

        // 5. ✅ Save to CLINIC_PROFILES_TABLE
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(clinicId) AND attribute_not_exists(userSub)"
        }));

        return {
            statusCode: 201,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Clinic profile created successfully",
                clinicId: profileData.clinicId
            })
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error creating clinic profile:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 409,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: "A profile already exists for this clinic and user"
                })
            };
        }

        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: err.message || "An unexpected error occurred" })
        };
    }
};