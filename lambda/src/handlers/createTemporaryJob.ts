import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { CognitoIdentityProviderClient, AdminGetUserCommand } from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { VALID_ROLE_VALUES, isDoctorRole } from "./professionalRoles";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const USER_POOL_ID = process.env.USER_POOL_ID || "";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// --- Initialization ---
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);
const cognito = new CognitoIdentityProviderClient({ region: REGION });

// --- Type Definitions ---

interface MultiJobData {
    clinicIds: string[]; // List of clinics to post to
    professional_role: string;
    professional_roles?: string[];
    date: string; // ISO date string
    shift_speciality: string;
    hours: number;
    rate?: number;
    start_time: string;
    end_time: string;
    meal_break?: string;
    job_title?: string;
    job_description?: string;
    requirements?: string[]; // Array of strings
    assisted_hygiene?: boolean;
    work_location_type?: string;
    pay_type?: string;
}

interface ClinicAddress {
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    city: string;
    state: string;
    pincode: string;
    fullAddress: string;
}

interface ProfileData {
    bookingOutPeriod: string;
    practiceType: string;
    primaryPracticeArea: string;
    clinicSoftware: string;
    freeParkingAvailable: boolean;
    parkingType: string;
}

// --- Helpers ---

const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, ""); 
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

/**
 * Reads one clinic profile row by composite key (clinicId + userSub).
 */
async function getClinicProfileByUser(clinicId: string, userSub: string): Promise<Record<string, any> | null> {
    try {
        const res = await ddbDoc.send(new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: clinicId, userSub: userSub },
        }));
        return res.Item || null;
    } catch (e) {
        console.warn(`Failed to fetch profile for ${userSub} in ${clinicId}`, e);
        return null;
    }
}

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
    // --- CORS preflight ---
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication (Access Token)
        let userSub: string;
        let userEmail: string = "";
        let userGroups: string[] = [];

        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
            userEmail = userInfo.email || "";
        } catch (authError: any) {
            console.error("Auth Error:", authError.message);
            return json(401, { error: authError.message || "Invalid access token" });
        }

        // 1b. Fetch user's first/last name from Cognito
        let cognitoFirstName = "";
        let cognitoLastName = "";
        if (USER_POOL_ID && userSub) {
            try {
                const cognitoUser = await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: userSub }));
                const attrs = cognitoUser.UserAttributes || [];
                cognitoFirstName = attrs.find(a => a.Name === "given_name")?.Value || "";
                cognitoLastName = attrs.find(a => a.Name === "family_name")?.Value || "";
                if (!userEmail) userEmail = attrs.find(a => a.Name === "email")?.Value || "";
            } catch { /* ignore */ }
        }

        // ---- Group Authorization ----
        const normalized = userGroups.map(normalizeGroup);
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
        
        if (!isAllowed) {
            console.warn(`[AUTH] User ${userSub} denied. Groups: [${userGroups.join(', ')}]`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied",
                details: { requiredGroups: Array.from(ALLOWED_GROUPS), userGroups }
            });
        }

        // 2. Parse Body
        const jobData: MultiJobData = JSON.parse(event.body || '{}');

        // 3. Validate Required Fields
        if (
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0 ||
            !jobData.professional_role ||
            !jobData.date ||
            !jobData.shift_speciality ||
            jobData.hours === undefined ||
            !jobData.start_time ||
            !jobData.end_time
        ) {
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields",
                details: {
                    requiredFields: ["clinicIds", "professional_role", "date", "shift_speciality", "hours", "start_time", "end_time"]
                }
            });
        }

        // 4. Validate Data Integrity

        // Support multi-role: accept professional_roles (array) or professional_role (string)
        const professionalRoles: string[] = Array.isArray(jobData.professional_roles)
            ? jobData.professional_roles
            : jobData.professional_role ? [jobData.professional_role] : [];

        if (professionalRoles.length === 0) {
            return json(400, {
                error: "Bad Request",
                message: "At least one professional role is required",
                details: { validRoles: VALID_ROLE_VALUES }
            });
        }

        // Validate each professional role
        const invalidRoles = professionalRoles.filter(r => !VALID_ROLE_VALUES.includes(r));
        if (invalidRoles.length > 0) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid professional role(s)",
                details: { validRoles: VALID_ROLE_VALUES, invalidRoles }
            });
        }

        // Validate work location type if provided
        const VALID_WORK_LOCATIONS = ['onsite', 'us_remote', 'global_remote'];
        if (jobData.work_location_type && !VALID_WORK_LOCATIONS.includes(jobData.work_location_type)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid work location type",
                details: { validOptions: VALID_WORK_LOCATIONS, provided: jobData.work_location_type }
            });
        }

        // Validate pay type if provided
        const VALID_PAY_TYPES = ['per_hour', 'per_transaction', 'percentage_of_revenue'];
        if (jobData.pay_type && !VALID_PAY_TYPES.includes(jobData.pay_type)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid pay type",
                details: { validOptions: VALID_PAY_TYPES, provided: jobData.pay_type }
            });
        }

        // per_transaction is not allowed for doctor roles
        if (jobData.pay_type === 'per_transaction' && professionalRoles.some(r => isDoctorRole(r))) {
            return json(400, {
                error: "Bad Request",
                message: "Per-transaction pay type is not available for doctor roles",
            });
        }

        // Validate date format and future
        const jobDate = new Date(jobData.date);
        if (isNaN(jobDate.getTime())) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid date format",
                details: { providedDate: jobData.date, expectedFormat: "ISO 8601 date string" }
            });
        }
        
        const today = new Date();
        today.setHours(0, 0, 0, 0); 
        if (jobDate < today) {
            return json(400, {
                error: "Bad Request",
                message: "Job date must be in the future",
                details: { providedDate: jobData.date, minimumDate: today.toISOString() }
            });
        }

        // Validate hours and rate
        if (jobData.hours < 1 || jobData.hours > 12) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid hours value",
                details: { providedHours: jobData.hours, validRange: "1-12" }
            });
        }
        // Validate compensation based on pay type
        const payType = jobData.pay_type || "per_hour";
        if (jobData.rate === undefined || jobData.rate === null) {
            return json(400, {
                error: "Bad Request",
                message: "Rate is required",
            });
        }
        if (payType === "per_hour") {
            if (jobData.rate < 10 || jobData.rate > 200) {
                return json(400, {
                    error: "Bad Request",
                    message: "Hourly rate must be between $10 and $200",
                    details: { providedRate: `$${jobData.rate}`, validRange: "$10-$200" }
                });
            }
        } else if (payType === "per_transaction") {
            if (jobData.rate <= 0) {
                return json(400, {
                    error: "Bad Request",
                    message: "Rate per transaction must be positive",
                });
            }
        } else if (payType === "percentage_of_revenue") {
            if (jobData.rate <= 0 || jobData.rate > 100) {
                return json(400, {
                    error: "Bad Request",
                    message: "Revenue percentage must be between 0 and 100",
                });
            }
        }

        const timestamp = new Date().toISOString();
        const jobIds: string[] = []; 

        // 5. Process Each Clinic
        const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
            const jobId = uuidv4();
            jobIds.push(jobId);

            // Fetch clinic (address + owner)
            const clinicResponse = await ddbDoc.send(new GetCommand({
                TableName: CLINICS_TABLE,
                Key: { clinicId: clinicId }
            }));
            
            const clinic = clinicResponse.Item;
            if (!clinic) {
                throw new Error(`Clinic not found: ${clinicId}`);
            }

            // Extract clinic address details
            const addressLine1 = clinic.addressLine1 || "";
            const addressLine2 = clinic.addressLine2 || "";
            const addressLine3 = clinic.addressLine3 || "";
            const city = clinic.city || "";
            const state = clinic.state || "";
            const pincode = clinic.pincode || "";
            const clinicOwnerSub = clinic.createdBy;

            // Fetch profile details (for job metadata)
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            // Fallback logic
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                 profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
            }

            const p = profileItem || {};
            const profileData: ProfileData = {
                bookingOutPeriod: p.booking_out_period || p.bookingOutPeriod || "immediate",
                clinicSoftware: p.clinic_software || p.software_used || "Unknown",
                freeParkingAvailable: p.free_parking_available ?? false,
                parkingType: p.parking_type || "N/A",
                practiceType: p.practice_type || p.practiceType || "General",
                primaryPracticeArea: p.primary_practice_area || p.primaryPracticeArea || "General Dentistry"
            };

            // Build item (No {S:}, {N:} needed for DocumentClient)
            const item: Record<string, any> = {
                clinicId: clinicId,
                clinicUserSub: userSub,
                jobId: jobId,
                job_type: "temporary",
                professional_role: professionalRoles[0],
                professional_roles: professionalRoles,
                date: jobData.date,
                shift_speciality: jobData.shift_speciality,
                hours: jobData.hours,
                rate: jobData.rate,
                pay_type: payType,
                start_time: jobData.start_time,
                end_time: jobData.end_time,
                meal_break: jobData.meal_break || "",
                
                // Address details
                addressLine1: addressLine1,
                addressLine2: addressLine2,
                addressLine3: addressLine3,
                city: city,
                state: state,
                pincode: pincode,
                fullAddress: `${addressLine1} ${addressLine2} ${addressLine3}, ${city}, ${state} ${pincode}`.replace(/\s+/g, " ").trim(),
                
                // Profile details
                bookingOutPeriod: profileData.bookingOutPeriod,
                clinicSoftware: profileData.clinicSoftware,
                freeParkingAvailable: profileData.freeParkingAvailable,
                parkingType: profileData.parkingType,
                practiceType: profileData.practiceType,
                primaryPracticeArea: profileData.primaryPracticeArea,
                
                // Work location
                ...(jobData.work_location_type && { work_location_type: jobData.work_location_type }),

                // Metadata
                status: "active",
                createdAt: timestamp,
                updatedAt: timestamp,
                created_by: `${cognitoFirstName} ${cognitoLastName}`.trim() || (userEmail && userEmail.includes("@") ? userEmail.split("@")[0] : userEmail) || "Unknown",
            };

            // Optional fields
            if (jobData.job_title) item.job_title = jobData.job_title;
            if (jobData.job_description) item.job_description = jobData.job_description;
            if (jobData.assisted_hygiene !== undefined) {
                item.assisted_hygiene = jobData.assisted_hygiene;
            }
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = new Set(jobData.requirements); // Sets map to SS
            }

            // Save
            await ddbDoc.send(new PutCommand({
                TableName: JOB_POSTINGS_TABLE,
                Item: item,
            }));
        });

        await Promise.all(postJobsPromises);

        // 6. Response
        return json(201, {
            status: "success",
            message: "Temporary job postings created successfully",
            data: {
                jobIds,
                jobType: "temporary",
                professionalRole: jobData.professional_role,
                date: jobData.date,
                hours: jobData.hours,
                payType: payType,
                rate: jobData.rate,
            },
            timestamp: timestamp
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating temporary job postings:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to create temporary job postings",
            details: { reason: err.message }
        });
    }
};