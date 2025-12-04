import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils"; 
import { VALID_ROLE_VALUES } from "./professionalRoles"; 
import { CORS_HEADERS } from "./corsHeaders";

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// --- Initialization ---
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- Type Definitions ---

interface JobData {
    clinicIds: string[];
    job_type: "temporary" | "multi_day_consulting" | "permanent";
    professional_role: string;
    shift_speciality: string;
    
    // Optional common fields
    job_title?: string;
    job_description?: string;
    requirements?: string[];
    
    // Temporary job fields
    date?: string;
    hours?: number;
    hourly_rate?: number;
    
    // Permanent job fields
    employment_type?: "full_time" | "part_time";
    salary_min?: number;
    salary_max?: number;
    benefits?: string[];
    vacation_days?: number;
    work_schedule?: string;
    start_date?: string;
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
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]); // Normalized for comparison
const ALLOWED_GROUPS_DISPLAY = ["Root", "ClinicAdmin", "ClinicManager"]; // For error messages

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

// --- Validation Functions ---

const validateTemporaryJob = (jobData: JobData): string | null => {
    if (!jobData.date || !jobData.hours || !jobData.hourly_rate) {
        return "Temporary job requires: date, hours, hourly_rate";
    }
    const jobDate = new Date(jobData.date);
    if (isNaN(jobDate.getTime())) {
        return "Invalid date format. Use ISO date string.";
    }
    if (jobData.hours < 1 || jobData.hours > 12) {
        return "Hours must be between 1 and 12";
    }
    if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
        return "Hourly rate must be between $10 and $200";
    }
    return null;
};

const validatePermanentJob = (jobData: JobData): string | null => {
    if (!jobData.employment_type || !jobData.salary_min || !jobData.salary_max || !jobData.benefits) {
        return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
    }
    if (jobData.salary_max < jobData.salary_min) {
        return "Maximum salary must be greater than minimum salary";
    }
    if (!Array.isArray(jobData.benefits)) {
        return "Benefits must be an array";
    }
    const validEmploymentTypes: string[] = ["full_time", "part_time"];
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
        } catch (authError: any) {
            console.error("Auth Error:", authError.message);
            return json(401, { 
                error: "Unauthorized",
                message: authError.message || "Invalid access token" 
            });
        }

        // 2. Group Authorization (Root, ClinicAdmin, ClinicManager only)
        const normalized = userGroups.map(normalizeGroup);
        console.log(`[AUTH DEBUG] User ${userSub}`);
        console.log(`[AUTH DEBUG] Raw groups:`, userGroups);
        console.log(`[AUTH DEBUG] Normalized groups:`, normalized);
        console.log(`[AUTH DEBUG] Allowed groups:`, Array.from(ALLOWED_GROUPS));
        
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
        console.log(`[AUTH DEBUG] Is allowed:`, isAllowed);
        
        if (!isAllowed) {
            console.warn(`[AUTH] User ${userSub} denied. Groups: [${userGroups.join(', ')}]`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied: only Root, ClinicAdmin, or ClinicManager can create jobs",
                details: { 
                    requiredGroups: ALLOWED_GROUPS_DISPLAY, // User-friendly display names
                    userGroups 
                }
            });
        }

        // 3. Parse Body
        const jobData: JobData = JSON.parse(event.body || '{}');

        // 4. Validate Common Required Fields
        if (
            !jobData.job_type ||
            !jobData.professional_role ||
            !jobData.shift_speciality ||
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0
        ) {
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields",
                details: {
                    requiredFields: ["job_type", "professional_role", "shift_speciality", "clinicIds (array)"]
                }
            });
        }

        // 5. Validate Job Type
        const validJobTypes: string[] = ["temporary", "multi_day_consulting", "permanent"];
        if (!validJobTypes.includes(jobData.job_type)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid job type",
                details: { 
                    validJobTypes, 
                    providedJobType: jobData.job_type 
                }
            });
        }

        // 6. Validate Professional Role
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid professional role",
                details: { 
                    validRoles: VALID_ROLE_VALUES, 
                    providedRole: jobData.professional_role 
                }
            });
        }

        // 7. Job Type Specific Validation
        let validationError: string | null = null;
        switch (jobData.job_type) {
            case "temporary":
                validationError = validateTemporaryJob(jobData);
                break;
            case "permanent":
                validationError = validatePermanentJob(jobData);
                break;
            // multi_day_consulting doesn't have specific validation yet
        }

        if (validationError) {
            return json(400, {
                error: "Bad Request",
                message: "Validation failed",
                details: { validationError }
            });
        }

        const timestamp = new Date().toISOString();
        const jobIds: string[] = [];

        // 8. Process Each Clinic
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
            const city = clinic.city || "";
            const state = clinic.state || "";
            const pincode = clinic.pincode || "";
            const fullAddress = `${addressLine1} ${addressLine2}`.replace(/\s+/g, " ").trim();
            const clinicOwnerSub = clinic.createdBy;

            // Fetch clinic profile: try current user first, then owner; otherwise defaults
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
            }

            const p = profileItem || {};
            const profileData: ProfileData = {
                bookingOutPeriod: p.bookingOutPeriod || p.booking_out_period || "immediate",
                clinicSoftware: p.softwareUsed || p.software_used || "Unknown",
                freeParkingAvailable: p.free_parking_available ?? false,
                parkingType: p.parking_type || "N/A",
                practiceType: p.practiceType || p.practice_type || "General",
                primaryPracticeArea: p.primaryPracticeArea || p.primary_practice_area || "General Dentistry"
            };

            // Build job posting item
            const item: Record<string, any> = {
                clinicId: clinicId,
                clinicUserSub: userSub,
                jobId: jobId,
                job_type: jobData.job_type,
                professional_role: jobData.professional_role,
                shift_speciality: jobData.shift_speciality,
                status: "active",
                createdAt: timestamp,
                updatedAt: timestamp,
                
                // Address fields
                addressLine1: addressLine1,
                addressLine2: addressLine2,
                fullAddress: fullAddress,
                city: city,
                state: state,
                pincode: pincode,
                
                // Profile fields
                bookingOutPeriod: profileData.bookingOutPeriod,
                clinicSoftware: profileData.clinicSoftware,
                freeParkingAvailable: profileData.freeParkingAvailable,
                parkingType: profileData.parkingType,
                practiceType: profileData.practiceType,
                primaryPracticeArea: profileData.primaryPracticeArea
            };

            // Optional common fields
            if (jobData.job_title) item.job_title = jobData.job_title;
            if (jobData.job_description) item.job_description = jobData.job_description;
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = new Set(jobData.requirements); // Sets map to SS in DynamoDB
            }

            // Job type specific fields
            if (jobData.job_type === "temporary") {
                if (jobData.date) item.date = jobData.date;
                if (jobData.hours) item.hours = jobData.hours;
                if (jobData.hourly_rate) item.hourly_rate = jobData.hourly_rate;
            }

            if (jobData.job_type === "permanent") {
                if (jobData.employment_type) item.employment_type = jobData.employment_type;
                if (jobData.salary_min) item.salary_min = jobData.salary_min;
                if (jobData.salary_max) item.salary_max = jobData.salary_max;
                if (jobData.benefits && jobData.benefits.length > 0) {
                    item.benefits = new Set(jobData.benefits);
                }
                if (jobData.vacation_days) item.vacation_days = jobData.vacation_days;
                if (jobData.work_schedule) item.work_schedule = jobData.work_schedule;
                if (jobData.start_date) item.start_date = jobData.start_date;
            }

            // Insert the job into DynamoDB
            await ddbDoc.send(new PutCommand({
                TableName: JOB_POSTINGS_TABLE,
                Item: item
            }));
        });

        await Promise.all(postJobsPromises);

        // 9. Response
        return json(201, {
            status: "success",
            message: "Job posting created for multiple clinics",
            data: {
                jobIds,
                jobType: jobData.job_type,
                professionalRole: jobData.professional_role,
                clinicsCount: jobData.clinicIds.length
            },
            timestamp: timestamp
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating job posting:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to create job posting",
            details: { reason: err.message }
        });
    }
};