import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand, GetCommand, GetCommandOutput, UpdateCommandInput } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || "us-east-1";
const CLINIC_PROFILES_TABLE: string = process.env.CLINIC_PROFILES_TABLE!; 

// Initialize V3 Client and Document Client (Abstracts Marshalling)
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 3. Type Definitions (Interfaces) ---

/** Interface for the expected incoming request body (camelCase, potentially nested) */
interface ClinicProfileBody {
    clinicName?: string;
    primaryContactFirstName?: string;
    primaryContactLastName?: string;
    practiceType?: string;
    primaryPracticeArea?: string;
    parkingType?: string;
    bookingOutPeriod?: string;
    softwareUsed?: string;
    numberOfOperatories?: number;
    numAssistants?: number;
    numDoctors?: number;
    numHygienists?: number;
    assistedHygieneAvailable?: boolean;
    freeParkingAvailable?: boolean;
    insurancePlansAccepted?: string[];
    notes?: string;
    website?: string;
    dentalAssociation?: string;
    location?: {
        addressLine1?: string;
        city?: string;
        state?: string;
        zipCode?: string;
    };
    contactInfo?: {
        phone?: string;
        email?: string;
    };
    [key: string]: any; // Allow other properties for flexibility
}

/** Interface for the DynamoDB-ready attributes (snake_case, flattened) */
interface DynamoBody {
    clinic_name?: string;
    primary_contact_first_name?: string;
    primary_contact_last_name?: string;
    practice_type?: string;
    primary_practice_area?: string;
    parking_type?: string;
    booking_out_period?: string;
    software_used?: string;
    number_of_operatories?: number;
    num_assistants?: number;
    num_doctors?: number;
    num_hygienists?: number;
    assisted_hygiene_available?: boolean;
    free_parking_available?: boolean;
    insurance_plans_accepted?: string[];
    description?: string; // Mapped from notes
    website?: string;
    dental_association?: string;
    address_line_1?: string;
    city?: string;
    state?: string;
    zip_code?: string;
    clinic_phone?: string;
    clinic_email?: string;
    [key: string]: any; // Allow other properties
}

/** Interface for the decoded Cognito JWT claims */
interface CognitoClaims {
    sub: string;
    "cognito:groups"?: string[];
    "custom:user_type"?: string;
    [key: string]: any;
}

// --- 4. Transformer Function ---

/**
 * Maps frontend camelCase/nested fields to backend DynamoDB snake_case/flattened attributes.
 * @param body - The raw request body from the frontend.
 * @returns The transformed and flattened object ready for DynamoDB.
 */
const transformBody = (body: ClinicProfileBody): DynamoBody => {
    const transformed: DynamoBody = {};
    
    // Define the full mapping object
    const mapping: Record<string, string | Record<string, string>> = {
        clinicName: "clinic_name",
        primaryContactFirstName: "primary_contact_first_name",
        primaryContactLastName: "primary_contact_last_name",
        practiceType: "practice_type",
        primaryPracticeArea: "primary_practice_area",
        parkingType: "parking_type",
        bookingOutPeriod: "booking_out_period",
        softwareUsed: "software_used",
        numberOfOperatories: "number_of_operatories",
        numAssistants: "num_assistants",
        numDoctors: "num_doctors",
        numHygienists: "num_hygienists",
        assistedHygieneAvailable: "assisted_hygiene_available",
        freeParkingAvailable: "free_parking_available",
        insurancePlansAccepted: "insurance_plans_accepted",
        notes: "description",
        website: "website",
        dentalAssociation: "dental_association",
        location: {
            addressLine1: "address_line_1",
            city: "city",
            state: "state",
            zipCode: "zip_code"
        },
        contactInfo: {
            phone: "clinic_phone",
            email: "clinic_email",
        },
    };

    for (const [key, value] of Object.entries(body)) {
        const mapValue = mapping[key];
        
        if (typeof mapValue === 'string') {
            // Direct attribute mapping
            transformed[mapValue as keyof DynamoBody] = value;
        } else if (typeof mapValue === 'object' && value && typeof value === 'object') {
            // Nested object mapping (e.g., location, contactInfo)
            const nestedMap = mapValue as Record<string, string>;
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                if (nestedMap[nestedKey]) {
                    transformed[nestedMap[nestedKey] as keyof DynamoBody] = nestedValue;
                }
            }
        }
    }

    return transformed;
};

// --- 5. Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🔧 Starting updateClinicProfile handler");

    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // Handle OPTIONS request for CORS preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Decode JWT token manually
        const authHeader: string | undefined = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            return json(401, { error: "Missing or invalid Authorization header" });
        }

        const token = authHeader.split(" ")[1];
        const payload = token.split(".")[1];
        
        if (!payload) {
             return json(401, { error: "Invalid JWT token format: missing payload" });
        }

        // Base64URL decoding: replace non-URL-safe characters before decoding
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
        const decodedClaims: CognitoClaims = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));

        const userSub: string = decodedClaims.sub;
        const groups: string[] = decodedClaims["cognito:groups"] || [];
        const userType: string = decodedClaims["custom:user_type"] || "professional";
        
        if (typeof userSub !== 'string' || userSub.trim().length === 0) {
             console.error("❌ userSub is missing or invalid in token claims.");
             return json(401, { error: "Invalid user identity in token." });
        }

        // Step 2: Get clinicId from API Gateway proxy path
        const pathParts: string[] = event.path?.split("/").filter(Boolean) || [];
        // The clinicId is the second-to-last segment (e.g., /clinics/a1b2c3d4/profile -> a1b2c3d4)
        const clinicIdFromPath: string | undefined = pathParts[pathParts.length - 2] || event.pathParameters?.clinicId;

        if (!clinicIdFromPath) {
            return json(400, { error: "Missing clinicId in URL path. Ensure the path format is /clinics/{clinicId}/profile" });
        }

        // Step 3: Verify user is authorized (Role Check)
        const isRootUser: boolean = groups.includes("Root");
        const isClinicUser: boolean = userType.toLowerCase() === "clinic" || groups.includes("clinic");

        if (!isRootUser && (!isClinicUser || userSub !== clinicIdFromPath)) {
            console.warn(`❌ Authorization failed for userSub: ${userSub} trying to update clinicId: ${clinicIdFromPath}.`);
            return json(403, { error: "Access denied – you are not authorized to update this clinic profile." });
        }

        // Step 4: Check ownership/existence via DynamoDB Get (using Composite Key)
        const profileIdForUpdate: string = clinicIdFromPath; 
        
        // Note: Composite Key: clinicId is partition key, userSub is sort key used in table definition
        const getCommand = new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: profileIdForUpdate, userSub: userSub }, 
        });

        let existingProfile: GetCommandOutput;
        try {
            existingProfile = await ddbDoc.send(getCommand);
        } catch (dbError) {
            console.error("❌ DynamoDB get error during ownership check:", dbError);
            return json(500, { error: "Failed to retrieve clinic profile for validation." });
        }

        if (!existingProfile.Item) {
            return json(404, { error: "Clinic profile not found or you do not have permission to access it." });
        }
        
        // =========================================================================
        // STEP 5: TRANSFORM, MAP, AND FILTER THE INCOMING DATA
        // =========================================================================
        
        const requestBody: ClinicProfileBody = JSON.parse(event.body || "{}");
        const dynamoBody: DynamoBody = transformBody(requestBody);

        // Define ALL allowed DynamoDB attribute names (snake_case)
        const allowedFields: (keyof DynamoBody)[] = [
            "assisted_hygiene_available", "booking_out_period", "city", "clinic_name", "clinic_phone",
            "free_parking_available", "insurance_plans_accepted", "num_assistants", "num_doctors",
            "num_hygienists", "number_of_operatories", "parking_type", "practice_type",
            "primary_contact_first_name", "primary_contact_last_name", "primary_practice_area",
            "software_used", "state", "description", "website", "dental_association",
            "clinic_email", "zip_code", "address_line_1",
        ];

        const validUpdateFields: DynamoBody = {};
        const updatedFields: string[] = [];

        // Filter the transformed body to only include allowed DynamoDB fields
        for (const field of allowedFields) {
             const value = dynamoBody[field];
             // The check for field existence in dynamoBody is implied by the loop over allowedFields.
             // We check if the value is explicitly provided in the request (even if null/empty string)
             if (dynamoBody.hasOwnProperty(field)) {
                validUpdateFields[field] = value;
                updatedFields.push(field as string);
             }
        }
        
        if (updatedFields.length === 0) {
            return json(400, { error: "No updateable fields provided in the request body after transformation." });
        }

        // Step 6: Build DynamoDB Update Expression
        let updateExpression: string = "SET ";
        const expressionAttributeNames: Record<string, string> = { "#updatedAt": "updatedAt" };
        const expressionAttributeValues: Record<string, any> = { ":updatedAt": new Date().toISOString() };
        
        const setExpressions: string[] = [];
        
        // Add updated fields to expressions and attributes
        updatedFields.forEach(field => {
            setExpressions.push(`#${field} = :${field}`);
            
            // Cast 'field' to string to satisfy Record<string, string>
            expressionAttributeNames[`#${field}`] = field as string;
            
            expressionAttributeValues[`:${field}`] = validUpdateFields[field as keyof DynamoBody];
        });

        updateExpression += setExpressions.join(", ");
        updateExpression += ", #updatedAt = :updatedAt"; // Always update the 'updatedAt' field

        const updateCommand = new UpdateCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: profileIdForUpdate, userSub: userSub }, 
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        });

        const result = await ddbDoc.send(updateCommand);

        console.info("✅ Clinic profile updated successfully for clinicId:", profileIdForUpdate);

        // Step 7: Return updated profile data
        return json(200, {
            message: "Clinic profile updated successfully",
            clinicId: profileIdForUpdate,
            updatedAt: expressionAttributeValues[":updatedAt"],
            profile: result.Attributes, 
        });

    } catch (error) {
        const err = error as Error;
        console.error("❌ Unhandled error in updateClinicProfile:", err);
        
        const errorMessage = err.message || "Failed to update clinic profile due to an unexpected error.";
        
        // Differentiate between known client errors and unexpected server errors
        const isClientError = errorMessage.includes("Authorization") || errorMessage.includes("identity") || errorMessage.includes("Missing clinicId") || errorMessage.includes("JWT");
        const statusCode = isClientError ? 401 : 500;
        
        return json(statusCode, { error: errorMessage });
    }
};