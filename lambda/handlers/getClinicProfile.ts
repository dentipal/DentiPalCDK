import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandInput, // Import the input type
    QueryCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Environment Variables
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE as string;
const CLINIC_JOBS_POSTED_TABLE = process.env.CLINIC_JOBS_POSTED_TABLE as string;
const CLINICS_JOBS_COMPLETED_TABLE = process.env.CLINICS_JOBS_COMPLETED_TABLE as string;

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Simplified type for a raw DynamoDB item
interface DynamoDBItem {
    clinicId?: AttributeValue;
    userSub?: AttributeValue;
    clinic_name?: AttributeValue;
    clinic_type?: AttributeValue;
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
    clinic_software?: AttributeValue; // S
    software_used?: AttributeValue; // S
    parking_type?: AttributeValue; // S
    free_parking_available?: AttributeValue; // BOOL
    createdAt?: AttributeValue; // S
    updatedAt?: AttributeValue; // S
    addressLine1?: AttributeValue; // S
    addressLine2?: AttributeValue; // S
    addressLine3?: AttributeValue; // S
    city?: AttributeValue; // S
    state?: AttributeValue; // S
    zipCode?: AttributeValue; // S
    contact_email?: AttributeValue; // S
    contact_phone?: AttributeValue; // S
    special_requirements?: AttributeValue; // SS
    // Fields specific to the Completed Jobs table
    acceptedRate?: AttributeValue; // N (assumed)
    [key: string]: AttributeValue | undefined;
}

// Interface for the base clinic profile structure
interface ClinicProfileBase {
    clinicId: string;
    userSub: string;
    clinicName: string;
    clinicType: string;
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
    clinic_software: string;
    software_used: string;
    parkingType: string;
    freeParkingAvailable: boolean;
    createdAt: string;
    updatedAt: string;
    location: {
        addressLine1: string;
        addressLine2: string;
        addressLine3: string;
        city: string;
        state: string;
        zipCode: string;
    };
    contactInfo: {
        email: string;
        phone: string;
    };
    specialRequirements: string[];
}

// Interface for the enriched clinic profile with stats
interface EnrichedClinicProfile extends ClinicProfileBase {
    jobsPosted: number;
    jobsCompleted: number;
    totalPaid: number;
}

/**
 * AWS Lambda handler to fetch a clinic user's profiles and enrich them with job statistics.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Validate the JWT token
        // validateToken is assumed to return the userSub (string) and throw on failure.
        const userSub: string = await validateToken(event as any);
        console.log("Extracted userSub:", userSub);

        // Step 2: Fetch clinic profiles
        const queryParams: QueryCommandInput = {
            TableName: CLINIC_PROFILES_TABLE,
            IndexName: "userSub-index", // Assumed GSI
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": { S: userSub },
            },
        };
        const result: QueryCommandOutput = await dynamodb.send(new QueryCommand(queryParams));

        if (!result.Items || result.Items.length === 0) {
            return json(404, { error: "No clinic profiles found" });
        }

        // Unmarshal the main clinic profiles (full version)
        const clinicProfiles: ClinicProfileBase[] = (result.Items as DynamoDBItem[]).map((clinic) => {
            
            // Helper to safely parse int, defaulting to 0
            const parseNum = (attr: AttributeValue | undefined): number => 
                attr?.N ? parseInt(attr.N, 10) : 0;
            // Helper to safely get string, defaulting to ""
            const str = (attr: AttributeValue | undefined): string => attr?.S || "";
            // Helper to safely get boolean, defaulting to false
            const bool = (attr: AttributeValue | undefined): boolean => attr?.BOOL || false;
            // Helper to safely get string array (SS), defaulting to []
            const strArr = (attr: AttributeValue | undefined): string[] => attr?.SS || [];
            

            return {
                clinicId: str(clinic.clinicId),
                userSub: str(clinic.userSub),
                clinicName: str(clinic.clinic_name),
                clinicType: str(clinic.clinic_type),
                practiceType: str(clinic.practice_type),
                primaryPracticeArea: str(clinic.primary_practice_area),
                primaryContactFirstName: str(clinic.primary_contact_first_name),
                primaryContactLastName: str(clinic.primary_contact_last_name),
                assistedHygieneAvailable: bool(clinic.assisted_hygiene_available),
                numberOfOperatories: parseNum(clinic.number_of_operatories),
                numHygienists: parseNum(clinic.num_hygienists),
                numAssistants: parseNum(clinic.num_assistants),
                numDoctors: parseNum(clinic.num_doctors),
                bookingOutPeriod: str(clinic.booking_out_period) || "immediate",
                clinic_software: str(clinic.clinic_software),
                software_used: str(clinic.software_used),
                parkingType: str(clinic.parking_type),
                freeParkingAvailable: bool(clinic.free_parking_available),
                createdAt: str(clinic.createdAt),
                updatedAt: str(clinic.updatedAt),
                location: {
                    addressLine1: str(clinic.addressLine1),
                    addressLine2: str(clinic.addressLine2),
                    addressLine3: str(clinic.addressLine3),
                    city: str(clinic.city),
                    state: str(clinic.state),
                    zipCode: str(clinic.zipCode),
                },
                contactInfo: {
                    email: str(clinic.contact_email),
                    phone: str(clinic.contact_phone),
                },
                specialRequirements: strArr(clinic.special_requirements),
            };
        });

        // -----------------------------------------------------------------
        // STEP 3: Enrich each profile with job stats (concurrently)
        // -----------------------------------------------------------------
        const enrichedProfiles: EnrichedClinicProfile[] = await Promise.all(
            clinicProfiles.map(async (clinic) => {
                // --- Get Posted Jobs Count ---
                // FIX: Explicitly type params as QueryCommandInput to allow 'Select' property string literal
                const postedParams: QueryCommandInput = {
                    TableName: CLINIC_JOBS_POSTED_TABLE,
                    IndexName: "ClinicIdIndex", 
                    KeyConditionExpression: "clinicId = :clinicId",
                    ExpressionAttributeValues: {
                        ":clinicId": { S: clinic.clinicId },
                    },
                    Select: "COUNT", // Now correctly interpreted as specific string literal
                };
                const postedResult: QueryCommandOutput = await dynamodb.send(new QueryCommand(postedParams));
                const jobsPosted: number = postedResult.Count || 0;

                // --- Get Completed Jobs Count & Total Paid ---
                const completedParams: QueryCommandInput = {
                    TableName: CLINICS_JOBS_COMPLETED_TABLE,
                    IndexName: "clinicId-index",
                    KeyConditionExpression: "clinicId = :clinicId",
                    ExpressionAttributeValues: {
                        ":clinicId": { S: clinic.clinicId },
                    },
                };
                const completedResult: QueryCommandOutput = await dynamodb.send(
                    new QueryCommand(completedParams)
                );

                const completedItems: DynamoDBItem[] = (completedResult.Items as DynamoDBItem[] || []);

                const jobsCompleted: number = completedItems.length;
                    
                // Calculate Total Paid
                const totalPaid: number = completedItems.reduce((acc, item) => {
                    // ⚠️ ASSUMPTION: 'acceptedRate' is a Number (N)
                    const amount = parseFloat(item.acceptedRate?.N || "0");
                    return acc + amount;
                }, 0);

                // Return the original clinic data + the new stats
                return {
                    ...clinic,
                    jobsPosted: jobsPosted,
                    jobsCompleted: jobsCompleted,
                    totalPaid: totalPaid,
                };
            })
        );

        // -----------------------------------------------------------------
        // STEP 4: Final Response
        // -----------------------------------------------------------------
        return json(200, {
            message: "Clinic profiles retrieved successfully",
            profiles: enrichedProfiles,
        });
    } catch (error: any) {
        // Log detailed error for debugging
        console.error("DETAILED ERROR:", error); 
        console.error("Error retrieving clinic profiles:", error);
        return json(500, { error: "Failed to retrieve clinic profiles" });
    }
};