import {
    DynamoDBClient,
    GetItemCommand,
    AttributeValue,
    GetItemCommandOutput,
    GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { extractUserFromBearerToken } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE as string;

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Simplified type for a raw DynamoDB item
interface DynamoDBClinicItem {
    clinicId?: AttributeValue;
    userSub?: AttributeValue;
    clinic_name?: AttributeValue;
    practice_type?: AttributeValue;
    primary_practice_area?: AttributeValue;
    primary_contact_first_name?: AttributeValue;
    primary_contact_last_name?: AttributeValue;
    assisted_hygiene_available?: AttributeValue; // BOOL
    number_of_operatories?: AttributeValue; // N
    num_hygienists?: AttributeValue; // N
    num_assistants?: AttributeValue; // N
    num_doctors?: AttributeValue; // N
    booking_out_period?: AttributeValue; // S
    software_used?: AttributeValue; // S
    parking_type?: AttributeValue; // S
    free_parking_available?: AttributeValue; // BOOL
    createdAt?: AttributeValue; // S
    updatedAt?: AttributeValue; // S
    addressLine1?: AttributeValue; // S
    city?: AttributeValue; // S
    state?: AttributeValue; // S
    zip_code?: AttributeValue; // S
    contact_email?: AttributeValue; // S
    clinic_phone?: AttributeValue; // S
    insurance_plans_accepted?: AttributeValue; // SS
    createdBy?: AttributeValue; // S
    website?: AttributeValue; // S
    dental_association?: AttributeValue; // S
    notes?: AttributeValue; // S
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped clinic profile structure
interface ClinicProfile {
    clinicId: string;
    userSub: string;
    clinicName: string;
    practiceType: string;
    primaryPracticeArea: string;
    primaryContactFirstName: string;
    primaryContactLastName: string;
    assistedHygieneAvailable: boolean;
    numberOfOperatories: number;
    numHygienists: number;
    numAssistants: number;
    numDoctors: number;
    bookingOutPeriod: string;
    softwareUsed: string;
    parkingType: string;
    freeParkingAvailable: boolean;
    createdAt: string;
    updatedAt: string;
    location: {
        addressLine1: string;
        city: string;
        state: string;
        zipCode: string;
    };
    contactInfo: {
        email: string;
        phone: string;
    };
    insurancePlansAccepted: string[];
    createdBy: string;
    website: string;
    dentalAssociation: string;
    notes: string;
}

// --- Helper Function ---

/**
 * Transforms a raw DynamoDB item into the structured ClinicProfile format.
 * @param clinic The raw DynamoDB item.
 * @returns The structured profile or null.
 */
const unmarshallClinic = (clinic: DynamoDBClinicItem | undefined): ClinicProfile | null => {
    if (!clinic) return null;

    const safeParseInt = (attr: AttributeValue | undefined): number => (attr?.N ? parseInt(attr.N, 10) : 0);
    const str = (attr: AttributeValue | undefined): string => attr?.S || "";
    const bool = (attr: AttributeValue | undefined): boolean => attr?.BOOL || false;
    const strArr = (attr: AttributeValue | undefined): string[] => attr?.SS || [];

    return {
        clinicId: str(clinic.clinicId),
        userSub: str(clinic.userSub),
        clinicName: str(clinic.clinic_name),
        practiceType: str(clinic.practice_type),
        primaryPracticeArea: str(clinic.primary_practice_area),
        primaryContactFirstName: str(clinic.primary_contact_first_name),
        primaryContactLastName: str(clinic.primary_contact_last_name),
        assistedHygieneAvailable: bool(clinic.assisted_hygiene_available),
        numberOfOperatories: safeParseInt(clinic.number_of_operatories),
        numHygienists: safeParseInt(clinic.num_hygienists),
        numAssistants: safeParseInt(clinic.num_assistants),
        numDoctors: safeParseInt(clinic.num_doctors),
        bookingOutPeriod: str(clinic.booking_out_period),
        softwareUsed: str(clinic.software_used),
        parkingType: str(clinic.parking_type),
        freeParkingAvailable: bool(clinic.free_parking_available),
        createdAt: str(clinic.createdAt),
        updatedAt: str(clinic.updatedAt),
        location: {
            addressLine1: str(clinic.addressLine1),
            city: str(clinic.city),
            state: str(clinic.state),
            zipCode: str(clinic.zip_code),
        },
        contactInfo: {
            email: str(clinic.contact_email),
            phone: str(clinic.clinic_phone),
        },
        insurancePlansAccepted: strArr(clinic.insurance_plans_accepted),
        createdBy: str(clinic.createdBy),
        website: str(clinic.website),
        dentalAssociation: str(clinic.dental_association),
        notes: str(clinic.notes),
    };
};

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication - Extract access token
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }

        // 2. Extract Clinic ID from Path
        const path = event.path || "";
        // Fallback logic for getting ID from path if pathParameters isn't populated
        const clinicId = event.pathParameters?.clinicId || path.split("/").filter(Boolean).pop();

        if (!clinicId) {
            console.error("Clinic ID is missing from the path.");
            return json(400, { error: "Clinic ID missing in request path." });
        }

        // 3. Fetch Item (using composite key for strict ownership check)
        // Key: { clinicId (SK), userSub (PK) } OR { clinicId (PK), userSub (SK) }
        // Based on your code, assuming: Key: { clinicId: { S: clinicId }, userSub: { S: userSub } }
        const getItemParams: GetItemCommandInput = {
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: { S: clinicId },
                userSub: { S: userSub }, 
            },
        };

        const result: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getItemParams));
        const item = result.Item as DynamoDBClinicItem | undefined;

        // 4. Check Existence
        if (!item) {
            console.error(`❌ No profile found for clinicId ${clinicId} and userSub ${userSub}`);
            return json(404, { error: `Clinic profile not found` });
        }

        // 5. Authorization Check (already implicitly performed by GetItem's use of userSub as key)
        // However, explicit check safeguards against Schema changes where userSub might not be part of the key.
        const fetchedUserSub = item.userSub?.S;
        if (fetchedUserSub !== userSub) {
            console.error(`Authorization failed: Clinic userSub (${fetchedUserSub}) does not match token userSub (${userSub})`);
            return json(403, { error: "Forbidden: You do not own this clinic profile." });
        }

        // 6. Format Data and Respond
        const clinicData = unmarshallClinic(item);

        return json(200, {
            message: "Clinic profile retrieved successfully",
            profile: clinicData,
        });

    } catch (error: any) {
        console.error("DETAILED ERROR:", error);
        return json(500, { 
            error: "Failed to retrieve clinic profile",
            details: error.message
        });
    }
};