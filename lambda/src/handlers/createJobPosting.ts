import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils"; 
import { VALID_ROLE_VALUES } from "./professionalRoles";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. Configuration ---
const REGION = process.env.REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// Initialize V3 Client and Document Client (Abstracts Marshalling)
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 3. Type Definitions ---

// 1. Base Job Interface (Common Fields)
interface BaseJobData {
    clinicId: string;
    job_type: 'temporary' | 'multi_day_consulting' | 'permanent';
    professional_role: string;
    shift_speciality: string;
    assisted_hygiene?: boolean;
    status?: 'active' | 'inactive' | 'filled';
    job_title?: string;
    job_description?: string;
    requirements?: string[]; // Array of strings
}

// 2. Specific Job Interfaces
interface TemporaryJobData extends BaseJobData {
    job_type: 'temporary';
    date: string; // ISO date string
    hours: number;
    hourly_rate: number;
    meal_break?: boolean;
    start_time?: string;
    end_time?: string;
}

interface MultiDayConsultingJobData extends BaseJobData {
    job_type: 'multi_day_consulting';
    dates: string[]; // Array of ISO date strings
    hours_per_day: number;
    hourly_rate: number;
    total_days: number;
    meal_break?: boolean;
    start_time?: string;
    end_time?: string;
    project_duration?: string;
}

interface PermanentJobData extends BaseJobData {
    job_type: 'permanent';
    employment_type: 'full_time' | 'part_time';
    salary_min: number;
    salary_max: number;
    benefits: string[];
    vacation_days?: number;
    work_schedule?: string;
    start_date?: string;
}

type JobData = TemporaryJobData | MultiDayConsultingJobData | PermanentJobData;

interface ClinicAddress {
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    fullAddress: string;
    city: string;
    state: string;
    pincode: string;
}

interface ClinicProfileDetails {
    bookingOutPeriod: string;
    clinicSoftware: string;
    freeParkingAvailable: boolean;
    parkingType: string;
    practiceType: string;
    primaryPracticeArea: string;
}

// --- 4. Validation Functions ---

const validateTemporaryJob = (jobData: TemporaryJobData): string | null => {
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

const validateMultiDayConsulting = (jobData: MultiDayConsultingJobData): string | null => {
    if (!jobData.dates || !jobData.hours_per_day || !jobData.hourly_rate || !jobData.total_days) {
        return "Multi-day consulting requires: dates, hours_per_day, hourly_rate, total_days";
    }
    if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
        return "Dates must be a non-empty array";
    }
    // Validate all dates
    for (const date of jobData.dates) {
        const jobDate = new Date(date);
        if (isNaN(jobDate.getTime())) {
            return `Invalid date format: ${date}. Use ISO date string.`;
        }
    }
    if (jobData.dates.length !== jobData.total_days) {
        return "Number of dates must match total_days";
    }
    if (jobData.hours_per_day < 1 || jobData.hours_per_day > 12) {
        return "Hours per day must be between 1 and 12";
    }
    return null;
};

const validatePermanentJob = (jobData: PermanentJobData): string | null => {
    if (!jobData.employment_type || !jobData.salary_min || !jobData.salary_max || !jobData.benefits) {
        return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
    }
    if (jobData.salary_min < 20000 || jobData.salary_min > 500000) {
        return "Minimum salary must be between $20,000 and $500,000";
    }
    if (jobData.salary_max < jobData.salary_min) {
        return "Maximum salary must be greater than minimum salary";
    }
    if (!Array.isArray(jobData.benefits)) {
        return "Benefits must be an array";
    }
    const validEmploymentTypes = ['full_time', 'part_time'];
    if (!validEmploymentTypes.includes(jobData.employment_type)) {
        return `Invalid employment_type. Valid options: ${validEmploymentTypes.join(', ')}`;
    }
    return null;
};

// --- 5. Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "{}" };
    }

    try {
        // 2. Authentication (Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        
        // 3. Parse Body
        const jobData: JobData = JSON.parse(event.body || '{}');

        // 4. Validate common required fields
        if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality || !jobData.clinicId) {
            return json(400, { error: "Required fields: clinicId, job_type, professional_role, shift_speciality" });
        }

        // Validate job type
        const validJobTypes = ['temporary', 'multi_day_consulting', 'permanent'];
        if (!validJobTypes.includes(jobData.job_type)) {
            return json(400, { error: `Invalid job_type. Valid options: ${validJobTypes.join(', ')}` });
        }

        // Validate professional role
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return json(400, { error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(', ')}` });
        }

        // 5. Job type specific validation
        let validationError: string | null = null;
        switch (jobData.job_type) {
            case 'temporary':
                validationError = validateTemporaryJob(jobData as TemporaryJobData);
                break;
            case 'multi_day_consulting':
                validationError = validateMultiDayConsulting(jobData as MultiDayConsultingJobData);
                break;
            case 'permanent':
                validationError = validatePermanentJob(jobData as PermanentJobData);
                break;
        }

        if (validationError) {
            return json(400, { error: validationError });
        }

        const jobId = uuidv4();
        const timestamp = new Date().toISOString();

        // 6. Fetch clinic address details
        const clinicRes = await ddbDoc.send(new GetCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: jobData.clinicId }
        }));

        const cItem = clinicRes.Item;
        if (!cItem) {
            return json(400, { error: `Clinic not found with ID: ${jobData.clinicId}` });
        }

        // Ensure all required address fields exist
        if (!cItem.addressLine1 || !cItem.city || !cItem.state || !cItem.pincode) {
             console.error("[DB_ERROR] Clinic item is missing required address fields.", cItem);
             return json(500, { error: "Clinic data is incomplete in the database." });
        }

        const clinicAddress: ClinicAddress = {
            addressLine1: cItem.addressLine1,
            addressLine2: cItem.addressLine2 ?? "", 
            addressLine3: cItem.addressLine3 ?? "", 
            fullAddress: `${cItem.addressLine1} ${cItem.addressLine2 || ''} ${cItem.addressLine3 || ''}`.trim(),
            city: cItem.city,
            state: cItem.state,
            pincode: cItem.pincode
        };

        // 7. Fetch profile details
        // Note: We use composite key clinicId + userSub (owner's sub) to find the profile
        const profileRes = await ddbDoc.send(new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: jobData.clinicId,
                userSub: userSub 
            }
        }));

        const clinicProfile = profileRes.Item;
        if (!clinicProfile) {
            return json(400, { error: "Profile not found for this clinic user. Please complete your clinic profile first." });
        }

        const profileDetails: ClinicProfileDetails = {
            bookingOutPeriod: clinicProfile.booking_out_period || "immediate",
            clinicSoftware: clinicProfile.clinic_software || "Unknown",
            freeParkingAvailable: clinicProfile.free_parking_available ?? false,
            parkingType: clinicProfile.parking_type || "N/A",
            practiceType: clinicProfile.practice_type || "General",
            primaryPracticeArea: clinicProfile.primary_practice_area || "General Dentistry"
        };

        // 8. Build DynamoDB item (using plain Objects, DocumentClient handles marshalling)
        const item: Record<string, any> = {
            clinicUserSub: userSub,
            jobId: jobId,
            clinicId: jobData.clinicId,
            job_type: jobData.job_type,
            professional_role: jobData.professional_role,
            shift_speciality: jobData.shift_speciality,
            assisted_hygiene: jobData.assisted_hygiene ?? false,
            status: jobData.status || 'active',
            createdAt: timestamp,
            updatedAt: timestamp,
            // Address details
            addressLine1: clinicAddress.addressLine1,
            addressLine2: clinicAddress.addressLine2,
            addressLine3: clinicAddress.addressLine3,
            fullAddress: clinicAddress.fullAddress,
            city: clinicAddress.city,
            state: clinicAddress.state,
            pincode: clinicAddress.pincode,
            // Profile details
            bookingOutPeriod: profileDetails.bookingOutPeriod,
            clinicSoftware: profileDetails.clinicSoftware,
            freeParkingAvailable: profileDetails.freeParkingAvailable,
            parkingType: profileDetails.parkingType,
            practiceType: profileDetails.practiceType,
            primaryPracticeArea: profileDetails.primaryPracticeArea
        };

        // 9. Add job type specific fields
        let responseData: Record<string, any> = {
            message: "Job posting created successfully",
            jobId,
            job_type: jobData.job_type,
            professional_role: jobData.professional_role
        };

        switch (jobData.job_type) {
            case 'temporary':
                const tempJob = jobData as TemporaryJobData;
                item.date = tempJob.date;
                item.hours = tempJob.hours;
                item.meal_break = tempJob.meal_break ?? false;
                item.hourly_rate = tempJob.hourly_rate;
                if (tempJob.start_time) item.start_time = tempJob.start_time;
                if (tempJob.end_time) item.end_time = tempJob.end_time;
                if (tempJob.job_title) item.job_title = tempJob.job_title;
                if (tempJob.job_description) item.job_description = tempJob.job_description;
                if (tempJob.requirements && tempJob.requirements.length > 0) {
                    item.requirements = new Set(tempJob.requirements); // DocumentClient prefers Sets for SS
                }
                responseData = {
                    ...responseData,
                    date: tempJob.date,
                    hours: tempJob.hours,
                    hourly_rate: tempJob.hourly_rate
                };
                break;

            case 'multi_day_consulting':
                const consultingJob = jobData as MultiDayConsultingJobData;
                item.dates = new Set(consultingJob.dates);
                item.hours_per_day = consultingJob.hours_per_day;
                item.total_days = consultingJob.total_days;
                item.meal_break = consultingJob.meal_break ?? false;
                item.hourly_rate = consultingJob.hourly_rate;
                if (consultingJob.start_time) item.start_time = consultingJob.start_time;
                if (consultingJob.end_time) item.end_time = consultingJob.end_time;
                if (consultingJob.project_duration) item.project_duration = consultingJob.project_duration;
                if (consultingJob.job_title) item.job_title = consultingJob.job_title;
                if (consultingJob.job_description) item.job_description = consultingJob.job_description;
                if (consultingJob.requirements && consultingJob.requirements.length > 0) {
                    item.requirements = new Set(consultingJob.requirements);
                }
                responseData = {
                    ...responseData,
                    dates: consultingJob.dates,
                    total_days: consultingJob.total_days,
                    hourly_rate: consultingJob.hourly_rate
                };
                break;

            case 'permanent':
                const permanentJob = jobData as PermanentJobData;
                if (permanentJob.job_title) item.job_title = permanentJob.job_title;
                if (permanentJob.job_description) item.job_description = permanentJob.job_description;
                item.employment_type = permanentJob.employment_type;
                item.salary_min = permanentJob.salary_min;
                item.salary_max = permanentJob.salary_max;
                item.benefits = new Set(permanentJob.benefits);
                if (permanentJob.vacation_days !== undefined) {
                    item.vacation_days = permanentJob.vacation_days;
                }
                if (permanentJob.work_schedule) {
                    item.work_schedule = permanentJob.work_schedule;
                }
                if (permanentJob.start_date) {
                    item.start_date = permanentJob.start_date;
                }
                if (permanentJob.requirements && permanentJob.requirements.length > 0) {
                    item.requirements = new Set(permanentJob.requirements);
                }
                responseData = {
                    ...responseData,
                    employment_type: permanentJob.employment_type,
                    salary_range: `$${permanentJob.salary_min.toLocaleString()} - $${permanentJob.salary_max.toLocaleString()}`,
                    benefits: permanentJob.benefits
                };
                break;
        }

        // 10. Save the job posting
        await ddbDoc.send(new PutCommand({
            TableName: JOB_POSTINGS_TABLE,
            Item: item
        }));

        return json(201, responseData);

    } catch (error) {
        const err = error as Error;
        console.error("Error creating job posting:", err);
        return json(500, { error: err.message || "An unexpected error occurred" });
    }
};