import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    QueryCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { extractUserFromBearerToken, canAccessClinic } from "./utils";
// Import shared CORS headers
import { corsHeaders } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE as string;
const CLINICS_TABLE = process.env.CLINICS_TABLE as string;

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Simplified type for a raw DynamoDB item
interface DynamoDBClinicItem {
    clinicId?: AttributeValue;
    userSub?: AttributeValue;
    clinic_name?: AttributeValue;
    title?: AttributeValue;
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
    parking_cost?: AttributeValue; // N
    free_parking_available?: AttributeValue; // BOOL
    createdAt?: AttributeValue; // S
    updatedAt?: AttributeValue; // S
    addressLine1?: AttributeValue; // S
    address_line_1?: AttributeValue; // S (legacy column name)
    city?: AttributeValue; // S
    state?: AttributeValue; // S
    zip_code?: AttributeValue; // S
    zipCode?: AttributeValue; // S (alternative column name)
    contact_email?: AttributeValue; // S
    clinic_phone?: AttributeValue; // S
    insurance_plans_accepted?: AttributeValue; // SS
    createdBy?: AttributeValue; // S
    website?: AttributeValue; // S
    dental_association?: AttributeValue; // S
    notes?: AttributeValue; // S
    description?: AttributeValue; // S (notes may be stored as description)
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped clinic profile structure
interface ClinicProfile {
    clinicId: string;
    userSub: string;
    clinicName: string;
    title: string;
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
    softwareUsed: string[];
    parkingType: string;
    parkingCost: number | null;
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
    const safeParseFloat = (attr: AttributeValue | undefined): number | null => {
        if (!attr?.N) return null;
        const v = parseFloat(attr.N);
        return Number.isFinite(v) ? v : null;
    };
    const str = (attr: AttributeValue | undefined): string => attr?.S || "";
    const bool = (attr: AttributeValue | undefined): boolean => attr?.BOOL || false;
    const strArr = (attr: AttributeValue | undefined): string[] => attr?.SS || [];

    // Handle software_used stored as String (S), List (L), or StringSet (SS)
    const parseSoftwareUsed = (attr: AttributeValue | undefined): string[] => {
        if (!attr) return [];
        if (attr.L) {
            return attr.L
                .map((v: AttributeValue) => v.S || "")
                .filter(Boolean);
        }
        if (attr.SS) return attr.SS;
        if (attr.S) {
            return attr.S.split(",").map((s: string) => s.trim()).filter(Boolean);
        }
        return [];
    };

    return {
        clinicId: str(clinic.clinicId),
        userSub: str(clinic.userSub),
        clinicName: str(clinic.clinic_name),
        title: str(clinic.title),
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
        softwareUsed: parseSoftwareUsed(clinic.software_used),
        parkingType: str(clinic.parking_type),
        parkingCost: safeParseFloat(clinic.parking_cost),
        freeParkingAvailable: bool(clinic.free_parking_available),
        createdAt: str(clinic.createdAt),
        updatedAt: str(clinic.updatedAt),
        location: {
            addressLine1: str(clinic.addressLine1) || str(clinic.address_line_1),
            city: str(clinic.city),
            state: str(clinic.state),
            zipCode: str(clinic.zip_code) || str(clinic.zipCode),
        },
        contactInfo: {
            email: str(clinic.contact_email),
            phone: str(clinic.clinic_phone),
        },
        insurancePlansAccepted: strArr(clinic.insurance_plans_accepted),
        createdBy: str(clinic.createdBy),
        website: str(clinic.website),
        dentalAssociation: str(clinic.dental_association),
        notes: str(clinic.notes) || str(clinic.description),
    };
};

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // 1. Authentication - Extract access token
        let userSub: string;
        let userGroups: string[] = [];
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            return json(event, 401, { error: authError.message || "Invalid access token" });
        }

        // 2. Extract Clinic ID from Path
        const path = event.path || "";
        // Fallback logic for getting ID from path if pathParameters isn't populated
        const clinicId = event.pathParameters?.clinicId || path.split("/").filter(Boolean).pop();

        if (!clinicId) {
            console.error("Clinic ID is missing from the path.");
            return json(event, 400, { error: "Clinic ID missing in request path." });
        }

        // 3. Authorization — any clinic member can READ the profile (Root bypasses).
        //    Previously this handler required the requester to BE the profile's creator
        //    (composite key {clinicId, userSub: requester}), which 404'd every user who
        //    was added to the clinic later — including all ClinicViewers.
        if (!(await canAccessClinic(userSub, userGroups, clinicId))) {
            console.warn(`[getClinicProfileDetails] Access denied: sub=${userSub} clinicId=${clinicId}`);
            return json(event, 403, { error: "Forbidden: you are not a member of this clinic" });
        }

        // 4. Query by clinicId only — profile is stored once per clinic (PK=clinicId, SK=userSub).
        //    Take the first row that comes back for this clinic.
        const queryParams: QueryCommandInput = {
            TableName: CLINIC_PROFILES_TABLE,
            KeyConditionExpression: "clinicId = :cid",
            ExpressionAttributeValues: { ":cid": { S: clinicId } },
            Limit: 1,
        };

        const result = await dynamodb.send(new QueryCommand(queryParams));
        const item = result.Items?.[0] as DynamoDBClinicItem | undefined;

        // 5. Check Existence
        if (!item) {
            console.warn(`No profile row exists for clinicId=${clinicId}`);
            return json(event, 404, { error: `Clinic profile not found` });
        }

        // 6. Format Data and Respond
        const clinicData = unmarshallClinic(item);

        // 7. Enrich with data from CLINICS_TABLE (address, name may only be stored there)
        if (clinicData && CLINICS_TABLE) {
            try {
                const clinicBaseResult = await dynamodb.send(new GetItemCommand({
                    TableName: CLINICS_TABLE,
                    Key: { clinicId: { S: clinicId } },
                    ProjectionExpression: "#n, addressLine1, addressLine2, city, #st, zipCode, pincode",
                    ExpressionAttributeNames: { "#n": "name", "#st": "state" },
                }));

                if (clinicBaseResult.Item) {
                    const c = clinicBaseResult.Item;
                    const s = (attr: AttributeValue | undefined): string => attr?.S || "";

                    // Merge: only fill in fields that are empty in the profile
                    if (!clinicData.clinicName) {
                        clinicData.clinicName = s(c.name);
                    }
                    if (!clinicData.location.addressLine1) {
                        clinicData.location.addressLine1 = s(c.addressLine1);
                    }
                    if (!clinicData.location.city) {
                        clinicData.location.city = s(c.city);
                    }
                    if (!clinicData.location.state) {
                        clinicData.location.state = s(c.state);
                    }
                    if (!clinicData.location.zipCode) {
                        clinicData.location.zipCode = s(c.zipCode) || s(c.pincode);
                    }
                }
            } catch (clinicFetchErr) {
                console.warn(`[getClinicProfileDetails] CLINICS_TABLE lookup failed for ${clinicId}:`, clinicFetchErr);
                // Don't fail the whole request if this lookup fails
            }
        }

        return json(event, 200, {
            message: "Clinic profile retrieved successfully",
            profile: clinicData,
        });

    } catch (error: any) {
        console.error("DETAILED ERROR:", error);
        return json(event, 500, { 
            error: "Failed to retrieve clinic profile",
            details: error.message
        });
    }
};