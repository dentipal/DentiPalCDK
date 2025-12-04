import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils"; 
import { VALID_ROLE_VALUES } from "./professionalRoles"; 
import { CORS_HEADERS } from "./corsHeaders";

// --- Configuration ---
const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// --- Initialization ---
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- Type Definitions ---

interface PermanentJobData {
    clinicIds: string[];
    professional_role: string;
    shift_speciality: string;
    job_type: "permanent"; // Enforced literal
    employment_type: "full_time" | "part_time";
    salary_min: number;
    salary_max: number;
    benefits: string[]; // Array of strings
    vacation_days?: number;
    work_schedule?: string;
    start_date?: string;
    job_title?: string;
    job_description?: string;
    requirements?: string[];
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

// --- Validation Helpers ---

const validatePermanentJob = (jobData: any): string | null => {
    if (!jobData.employment_type || jobData.salary_min === undefined || jobData.salary_max === undefined || !jobData.benefits) {
        return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
    }

    const salaryMin = Number(jobData.salary_min);
    const salaryMax = Number(jobData.salary_max);

    if (salaryMax < salaryMin) {
        return "Maximum salary must be greater than minimum salary";
    }
    if (!Array.isArray(jobData.benefits)) {
        return "Benefits must be an array";
    }

    const validEmploymentTypes = ["full_time", "part_time"];
    if (!validEmploymentTypes.includes(jobData.employment_type)) {
        return `Invalid employment_type. Valid options: ${validEmploymentTypes.join(", ")}`;
    }
    return null;
};

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication (Access Token)
        let userSub: string;
        let userGroups: string[] = [];
        
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
            
            // Debug Log
            console.log("Auth Debug:", { userSub, userGroups });

        } catch (authError: any) {
            console.error("Auth Error:", authError.message);
            return json(401, { error: authError.message || "Invalid access token" });
        }

        // ---- Group Authorization ----
        // Check if user belongs to any allowed group (case-insensitive)
        const ALLOWED_GROUPS_NORMALIZED = new Set(["root", "clinicadmin", "clinicmanager"]);
        const normalized = userGroups.map(normalizeGroup);
        const isAllowedGlobally = normalized.some(g => ALLOWED_GROUPS_NORMALIZED.has(g));
        
        // 2. Parse Body
        const jobData: PermanentJobData = JSON.parse(event.body || '{}');

        // 3. Validate Common Fields
        if (
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0 ||
            !jobData.professional_role ||
            !jobData.shift_speciality ||
            jobData.job_type !== "permanent"
        ) {
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields or invalid job_type",
                details: {
                    requiredFields: ["clinicIds", "professional_role", "shift_speciality", "job_type='permanent'"]
                }
            });
        }

        // 4. Validate Role
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES, providedRole: jobData.professional_role }
            });
        }

        // 5. Validate Permanent Specifics
        const validationError = validatePermanentJob(jobData);
        if (validationError) {
             return json(400, {
                error: "Bad Request",
                message: "Job validation failed",
                details: { validationError }
            });
        }

        // 6. Permission Check per Clinic (if not global admin)
        if (!isAllowedGlobally) {
            for (const clinicId of jobData.clinicIds) {
                const clinicRes = await ddbDoc.send(new GetCommand({
                    TableName: CLINICS_TABLE,
                    Key: { clinicId }
                }));
                
                if (!clinicRes.Item) return json(400, { message: `Clinic not found: ${clinicId}` });

                const clinicOwner = clinicRes.Item.createdBy;
                if (clinicOwner === userSub) continue;

                const profile = await getClinicProfileByUser(clinicId, userSub);
                if (profile) continue;

                return json(403, { 
                    error: "Forbidden", 
                    message: `User does not have permission for clinic ${clinicId}` 
                });
            }
        }

        const timestamp = new Date().toISOString();
        const jobIds: string[] = []; 

        // 7. Process Each Clinic
        const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
            const jobId = uuidv4();
            jobIds.push(jobId);

            // Fetch Clinic
            const clinicResponse = await ddbDoc.send(new GetCommand({
                TableName: CLINICS_TABLE,
                Key: { clinicId: clinicId }
            }));
            
            const clinic = clinicResponse.Item;
            if (!clinic) throw new Error(`Clinic not found: ${clinicId}`);

            // Extract address
            const addressLine1 = clinic.addressLine1 || "";
            const addressLine2 = clinic.addressLine2 || "";
            const city = clinic.city || "";
            const state = clinic.state || "";
            const pincode = clinic.pincode || "";
            const clinicOwnerSub = clinic.createdBy;

            // Fetch Profile
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                 profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
            }

            const p = profileItem || {};
            const profileData: ProfileData = {
                bookingOutPeriod: p.booking_out_period || p.bookingOutPeriod || "immediate",
                clinicSoftware: p.clinic_software || p.softwareUsed || p.software_used || "Unknown",
                freeParkingAvailable: p.free_parking_available ?? false,
                parkingType: p.parking_type || "N/A",
                practiceType: p.practice_type || p.practiceType || "General",
                primaryPracticeArea: p.primary_practice_area || p.primaryPracticeArea || "General Dentistry"
            };

            // Build Item (DocumentClient syntax - no Types!)
            const item: Record<string, any> = {
                clinicId: clinicId,
                clinicUserSub: userSub,
                jobId: jobId,
                job_type: "permanent",
                professional_role: jobData.professional_role,
                shift_speciality: jobData.shift_speciality,
                
                // Permanent Specifics
                employment_type: jobData.employment_type,
                salary_min: jobData.salary_min,
                salary_max: jobData.salary_max,
                benefits: new Set(jobData.benefits), // Set maps to String Set (SS)
                
                status: "active",
                createdAt: timestamp,
                updatedAt: timestamp,

                // Address
                addressLine1, addressLine2, city, state, pincode,
                fullAddress: `${addressLine1} ${addressLine2}, ${city}, ${state} ${pincode}`.replace(/\s+/g, " ").trim(),

                // Profile
                bookingOutPeriod: profileData.bookingOutPeriod,
                clinicSoftware: profileData.clinicSoftware,
                freeParkingAvailable: profileData.freeParkingAvailable,
                parkingType: profileData.parkingType,
                practiceType: profileData.practiceType,
                primaryPracticeArea: profileData.primaryPracticeArea
            };

            // Optionals
            if (jobData.job_title) item.job_title = jobData.job_title;
            if (jobData.job_description) item.job_description = jobData.job_description;
            if (jobData.vacation_days) item.vacation_days = jobData.vacation_days;
            if (jobData.work_schedule) item.work_schedule = jobData.work_schedule;
            if (jobData.start_date) item.start_date = jobData.start_date;
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = new Set(jobData.requirements);
            }

            // Save
            await ddbDoc.send(new PutCommand({
                TableName: JOB_POSTINGS_TABLE,
                Item: item,
            }));
        });

        await Promise.all(postJobsPromises);

        return json(201, {
            status: "success",
            message: "Permanent job postings created successfully",
            data: {
                jobIds,
                jobType: "permanent",
                clinicsCount: jobData.clinicIds.length,
                createdAt: timestamp
            },
            timestamp: timestamp
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating permanent job:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to create permanent job postings",
            details: { reason: err.message }
        });
    }
};