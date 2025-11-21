import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { 
    DynamoDBClient, 
    GetItemCommand, 
    PutItemCommand, 
    AttributeValue 
} from "@aws-sdk/client-dynamodb";
// Updated imports to use the new token extraction utility
import { extractUserFromBearerToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

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

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    try {
        // 1. Authorization and Input Parsing (Using Access Token)
        let userSub: string;
        
        try {
            // Extract Access Token from Authorization header
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            
            // Use utility to decode Access Token
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            // Note: We aren't strictly checking groups here because the logic below 
            // checks if the user is associated with the clinic in the DB.
            // However, we could add a check like: if (!isRoot(userInfo.groups) && !isClinicRole(userInfo.groups)) ...
            
        } catch (authError: any) {
            console.error("Authentication failed:", authError.message);
            return json(401, { error: authError.message || "Invalid access token" });
        }

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
            return json(400, {
                error: "Required fields: clinicId, practice_type, primary_practice_area, primary_contact_first_name, primary_contact_last_name"
            });
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
            return json(404, { error: "Clinic not found with provided clinicId" });
        }

        // Check if userSub is in the AssociatedUsers list
        // Access Token 'sub' is reliable for this check
        const associatedUsers = clinicItem.AssociatedUsers?.L?.map(u => u.S) || [];
        if (!associatedUsers.includes(userSub)) {
            console.warn(`[AUTH] User ${userSub} is not associated with clinic ${profileData.clinicId}.`);
            return json(403, { error: "User is not authorized to create a profile for this clinic" });
        }

        // 3. ✅ Build the item using Record<string, AttributeValue>
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
            // Skip fields we already manually mapped or standard fields to prevent overwriting with raw values
            if (!item[key] && value !== undefined) {
                if (typeof value === "string") {
                    item[key] = { S: value };
                } else if (typeof value === "boolean") {
                    item[key] = { BOOL: value };
                } else if (typeof value === "number") {
                    item[key] = { N: value.toString() };
                } else if (Array.isArray(value)) {
                    const stringArray = value.filter(v => typeof v === 'string') as string[];
                    if (stringArray.length > 0) {
                        item[key] = { SS: stringArray };
                    }
                }
            }
        });

        // 5. ✅ Save to CLINIC_PROFILES_TABLE
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(clinicId) AND attribute_not_exists(userSub)"
        }));

        return json(201, {
            message: "Clinic profile created successfully",
            clinicId: profileData.clinicId
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating clinic profile:", err);

        if (err.name === "ConditionalCheckFailedException") {
            return json(409, {
                error: "A profile already exists for this clinic and user"
            });
        }
        
        // Check for auth-specific errors thrown by extractUserFromBearerToken
        if (err.message === "Authorization header missing" || err.message.includes("Invalid access token")) {
             return json(401, { error: err.message });
        }

        return json(500, {
            error: err.message || "An unexpected error occurred"
        });
    }
};