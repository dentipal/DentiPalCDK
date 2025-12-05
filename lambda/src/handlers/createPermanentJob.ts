import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken, hasClinicAccess, isRoot } from "./utils"; 
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
    
    // Multi-day consulting fields
    dates?: string[];
    total_days?: number;
    hours_per_day?: number;
    project_duration?: string;
    
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
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);
const ALLOWED_GROUPS_DISPLAY = ["Root", "ClinicAdmin", "ClinicManager"];

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
    // ✅ FIX: Check date is in the future
    if (jobDate <= new Date()) {
        return "Job date must be in the future";
    }
    if (jobData.hours < 1 || jobData.hours > 12) {
        return "Hours must be between 1 and 12";
    }
    if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
        return "Hourly rate must be between $10 and $200";
    }
    return null;
};

const validateMultiDayConsulting = (jobData: JobData): string | null => {
    // ✅ FIX: Added validation for multi-day consulting
    if (!jobData.dates || !Array.isArray(jobData.dates) || jobData.dates.length === 0) {
        return "Multi-day consulting requires: dates (array)";
    }
    if (jobData.dates.length > 30) {
        return "Cannot schedule more than 30 days";
    }
    // Validate all dates are in the future
    const now = new Date();
    for (const dateStr of jobData.dates) {
        const date = new Date(dateStr);
        if (isNaN(date.getTime())) {
            return `Invalid date format: ${dateStr}`;
        }
        if (date <= now) {
            return `All dates must be in the future. Invalid: ${dateStr}`;
        }
    }
    if (jobData.hours_per_day && (jobData.hours_per_day < 1 || jobData.hours_per_day > 12)) {
        return "Hours per day must be between 1 and 12";
    }
    if (jobData.hourly_rate && (jobData.hourly_rate < 10 || jobData.hourly_rate > 300)) {
        return "Hourly rate must be between $10 and $300";
    }
    return null;
};

const validatePermanentJob = (jobData: JobData): string | null => {
    // ✅ FIX: Check if fields exist AND are valid types
    if (!jobData.employment_type) {
        return "Permanent job requires: employment_type";
    }
    if (typeof jobData.salary_min !== 'number' || typeof jobData.salary_max !== 'number') {
        return "Permanent job requires: salary_min and salary_max (numbers)";
    }
    if (!Array.isArray(jobData.benefits)) {
        return "Benefits must be an array";
    }
    
    // ✅ FIX: Add salary range validation
    if (jobData.salary_min < 20000 || jobData.salary_min > 500000) {
        return "Minimum salary must be between $20,000 and $500,000";
    }
    if (jobData.salary_max < 20000 || jobData.salary_max > 500000) {
        return "Maximum salary must be between $20,000 and $500,000";
    }
    if (jobData.salary_max <= jobData.salary_min) {
        return "Maximum salary must be greater than minimum salary";
    }
    
    const validEmploymentTypes: string[] = ["full_time", "part_time"];
    if (!validEmploymentTypes.includes(jobData.employment_type)) {
        return `Invalid employment_type. Valid options: ${validEmploymentTypes.join(", ")}`;
    }
    
    // ✅ FIX: Validate vacation days if provided
    if (jobData.vacation_days !== undefined && (jobData.vacation_days < 0 || jobData.vacation_days > 50)) {
        return "Vacation days must be between 0 and 50";
    }
    
    return null;
};

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('🚀 HANDLER STARTED - createPermanentJob.ts');
    console.log('HTTP Method:', event.httpMethod);
    console.log('Path:', event.path);
    
    // --- CORS preflight ---
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication (Access Token)
        console.log('=== AUTHENTICATION START ===');
        
        let userSub: string;
        let userGroups: string[] = [];
        
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        console.log('Authorization header present:', !!authHeader);
        
        const userInfo = extractUserFromBearerToken(authHeader);
        console.log('extractUserFromBearerToken success');
        
        userSub = userInfo.sub;
        userGroups = userInfo.groups || [];
        console.log('Extracted userSub:', userSub);
        console.log('Extracted userGroups:', JSON.stringify(userGroups));
        
        console.log('=== AUTHENTICATION END ===');

        // 2. Group Authorization (Root, ClinicAdmin, ClinicManager only)
        console.log('=== AUTHORIZATION START ===');
        const normalized = userGroups.map(normalizeGroup);
        console.log(`User ${userSub} - Normalized groups:`, JSON.stringify(normalized));
        
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
        console.log(`Is allowed:`, isAllowed);
        console.log('=== AUTHORIZATION END ===');
        
        if (!isAllowed) {
            console.warn(`User ${userSub} denied. Groups: [${userGroups.join(', ')}]`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied: only Root, ClinicAdmin, or ClinicManager can create jobs",
                details: { 
                    requiredGroups: ALLOWED_GROUPS_DISPLAY,  
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
            case "multi_day_consulting":
                // ✅ FIX: Added validation for multi-day consulting
                validationError = validateMultiDayConsulting(jobData);
                break;
            case "permanent":
                validationError = validatePermanentJob(jobData);
                break;
        }

        if (validationError) {
            return json(400, {
                error: "Bad Request",
                message: "Validation failed",
                details: { validationError }
            });
        }

        // ✅ FIX: Verify user has access to all clinics BEFORE creating jobs
        console.log('=== CLINIC ACCESS VERIFICATION START ===');
        const isRootUser = isRoot(userGroups);
        
        if (!isRootUser) {
            // Non-root users must have access to each clinic
            for (const clinicId of jobData.clinicIds) {
                const hasAccess = await hasClinicAccess(userSub, clinicId);
                if (!hasAccess) {
                    console.warn(`User ${userSub} denied access to clinic ${clinicId}`);
                    return json(403, {
                        error: "Forbidden",
                        message: `Access denied to clinic ${clinicId}`,
                        details: { 
                            reason: "You can only create jobs for clinics you manage",
                            deniedClinicId: clinicId
                        }
                    });
                }
            }
        }
        console.log('=== CLINIC ACCESS VERIFICATION END ===');

        const timestamp = new Date().toISOString();
        const jobIds: string[] = [];
        const createdJobs: any[] = [];
        const failedClinics: { clinicId: string, error: string }[] = [];

        // 8. Process Each Clinic with better error handling
        const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
            try {
                const jobId = uuidv4();

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
                    item.requirements = new Set(jobData.requirements);
                }

                // Job type specific fields
                if (jobData.job_type === "temporary") {
                    if (jobData.date) item.date = jobData.date;
                    if (jobData.hours) item.hours = jobData.hours;
                    if (jobData.hourly_rate) item.hourly_rate = jobData.hourly_rate;
                }

                if (jobData.job_type === "multi_day_consulting") {
                    if (jobData.dates && jobData.dates.length > 0) {
                        item.dates = new Set(jobData.dates);
                        item.total_days = jobData.dates.length;
                    }
                    if (jobData.hours_per_day) item.hours_per_day = jobData.hours_per_day;
                    if (jobData.hourly_rate) item.hourly_rate = jobData.hourly_rate;
                    if (jobData.project_duration) item.project_duration = jobData.project_duration;
                }

                if (jobData.job_type === "permanent") {
                    if (jobData.employment_type) item.employment_type = jobData.employment_type;
                    if (jobData.salary_min) item.salary_min = jobData.salary_min;
                    if (jobData.salary_max) item.salary_max = jobData.salary_max;
                    if (jobData.benefits && jobData.benefits.length > 0) {
                        item.benefits = new Set(jobData.benefits);
                    }
                    if (jobData.vacation_days !== undefined) item.vacation_days = jobData.vacation_days;
                    if (jobData.work_schedule) item.work_schedule = jobData.work_schedule;
                    if (jobData.start_date) item.start_date = jobData.start_date;
                }

                // Insert the job into DynamoDB
                await ddbDoc.send(new PutCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    Item: item
                }));

                jobIds.push(jobId);
                createdJobs.push({ clinicId, jobId });
                
            } catch (error: any) {
                console.error(`Failed to create job for clinic ${clinicId}:`, error);
                failedClinics.push({ 
                    clinicId, 
                    error: error.message || 'Unknown error' 
                });
            }
        });

        await Promise.all(postJobsPromises);

        // ✅ FIX: Better response with partial success handling
        if (jobIds.length === 0) {
            return json(500, {
                error: "Internal Server Error",
                message: "Failed to create any job postings",
                details: {
                    failedClinics,
                    totalRequested: jobData.clinicIds.length
                }
            });
        }

        // 9. Response
        const response: any = {
            status: "success",
            message: `Job posting created for ${jobIds.length} clinic(s)`,
            data: {
                jobIds,
                createdJobs,
                jobType: jobData.job_type,
                professionalRole: jobData.professional_role,
                successCount: jobIds.length,
                totalRequested: jobData.clinicIds.length
            },
            timestamp: timestamp
        };

        // Include failed clinics if any
        if (failedClinics.length > 0) {
            response.status = "partial_success";
            response.message = `Job posting created for ${jobIds.length} of ${jobData.clinicIds.length} clinic(s)`;
            response.data.failedClinics = failedClinics;
            response.data.failedCount = failedClinics.length;
        }

        return json(jobIds.length === jobData.clinicIds.length ? 201 : 207, response);

    } catch (error: any) {
        console.error("Error creating job posting:", error);
        
        // ✅ FIX: Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }
        
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to create job posting",
            details: { reason: error.message }
        });
    }
};
