import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    PutItemCommand,
    GetItemCommand,
    AttributeValue,
    GetItemCommandOutput
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { validateToken } from "./utils"; // Assumed dependency
import { VALID_ROLE_VALUES } from "./professionalRoles"; // Assumed dependency

// --- Type Definitions ---

// Simplified type for the expected DynamoDB Item structure
interface DynamoDBItem {
    [key: string]: AttributeValue;
}

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

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Validation Functions ---

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

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Authorization and Parsing
        const userSub: string = await validateToken(event); // This user should be a clinic user
        // Cast the parsed body to the general JobData type for initial validation
        const jobData: JobData = JSON.parse(event.body || '{}');

        // 2. Validate common required fields
        if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality || !jobData.clinicId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Required fields: clinicId, job_type, professional_role, shift_speciality"
                })
            };
        }

        // Validate job type
        const validJobTypes = ['temporary', 'multi_day_consulting', 'permanent'];
        if (!validJobTypes.includes(jobData.job_type)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid job_type. Valid options: ${validJobTypes.join(', ')}`
                })
            };
        }

        // Validate professional role
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(', ')}`
                })
            };
        }

        // 3. Job type specific validation
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
            return {
                statusCode: 400,
                body: JSON.stringify({ error: validationError })
            };
        }

        const jobId = uuidv4();
        const timestamp = new Date().toISOString();

        // 4. Fetch clinic address details from CLINICS_TABLE
        const clinicCommand = new GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: {
                clinicId: { S: jobData.clinicId }
            }
        });

        const clinicResponse: GetItemCommandOutput = await dynamodb.send(clinicCommand);
        if (!clinicResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: `Clinic not found with ID: ${jobData.clinicId}` })
            };
        }

        const cItem = clinicResponse.Item;

        // Ensure all required address fields exist before accessing .S
        if (!cItem.addressLine1?.S || !cItem.city?.S || !cItem.state?.S || !cItem.pincode?.S) {
             console.error("[DB_ERROR] Clinic item is missing required address fields.", cItem);
             return {
                statusCode: 500,
                body: JSON.stringify({ error: "Clinic data is incomplete in the database." })
            };
        }

        const clinicAddress: ClinicAddress = {
            addressLine1: cItem.addressLine1.S,
            addressLine2: cItem.addressLine2?.S || '', // Optional fields
            addressLine3: cItem.addressLine3?.S || '', // Optional fields
            fullAddress: `${cItem.addressLine1.S} ${cItem.addressLine2?.S || ''} ${cItem.addressLine3?.S || ''}`.trim(),
            city: cItem.city.S,
            state: cItem.state.S,
            pincode: cItem.pincode.S
        };


        // 5. Fetch profile details from the CLINIC_PROFILES_TABLE
        const profileCommand = new GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE, // Table holds composite key (clinicId + userSub)
            Key: {
                clinicId: { S: jobData.clinicId },
                userSub: { S: userSub }
            }
        });

        const profileResponse: GetItemCommandOutput = await dynamodb.send(profileCommand);
        if (!profileResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Profile not found for this clinic user. Please complete your clinic profile first." })
            };
        }

        const clinicProfile = profileResponse.Item;
        const profileDetails: ClinicProfileDetails = {
            bookingOutPeriod: clinicProfile.booking_out_period?.S || "immediate",
            clinicSoftware: clinicProfile.clinic_software?.S || "Unknown",
            freeParkingAvailable: clinicProfile.free_parking_available?.BOOL || false,
            parkingType: clinicProfile.parking_type?.S || "N/A",
            practiceType: clinicProfile.practice_type?.S || "General",
            primaryPracticeArea: clinicProfile.primary_practice_area?.S || "General Dentistry"
        };

        // 6. Build base DynamoDB item (common fields)
        const item: DynamoDBItem = {
            clinicUserSub: { S: userSub },
            jobId: { S: jobId },
            clinicId: { S: jobData.clinicId },
            job_type: { S: jobData.job_type },
            professional_role: { S: jobData.professional_role },
            shift_speciality: { S: jobData.shift_speciality },
            assisted_hygiene: { BOOL: jobData.assisted_hygiene ?? false }, // Use nullish coalescing for default
            status: { S: jobData.status || 'active' },
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
            // Address details
            addressLine1: { S: clinicAddress.addressLine1 },
            addressLine2: { S: clinicAddress.addressLine2 },
            addressLine3: { S: clinicAddress.addressLine3 },
            fullAddress: { S: clinicAddress.fullAddress },
            city: { S: clinicAddress.city },
            state: { S: clinicAddress.state },
            pincode: { S: clinicAddress.pincode },
            // Profile details
            bookingOutPeriod: { S: profileDetails.bookingOutPeriod },
            clinicSoftware: { S: profileDetails.clinicSoftware },
            freeParkingAvailable: { BOOL: profileDetails.freeParkingAvailable },
            parkingType: { S: profileDetails.parkingType },
            practiceType: { S: profileDetails.practiceType },
            primaryPracticeArea: { S: profileDetails.primaryPracticeArea }
        };

        // 7. Add job type specific fields and build response data
        let responseData: Record<string, any> = {
            message: "Job posting created successfully",
            jobId,
            job_type: jobData.job_type,
            professional_role: jobData.professional_role
        };

        switch (jobData.job_type) {
            case 'temporary':
                const tempJob = jobData as TemporaryJobData;
                item.date = { S: tempJob.date };
                item.hours = { N: tempJob.hours.toString() };
                item.meal_break = { BOOL: tempJob.meal_break ?? false };
                item.hourly_rate = { N: tempJob.hourly_rate.toString() };
                if (tempJob.start_time) item.start_time = { S: tempJob.start_time };
                if (tempJob.end_time) item.end_time = { S: tempJob.end_time };
                if (tempJob.job_title) item.job_title = { S: tempJob.job_title };
                if (tempJob.job_description) item.job_description = { S: tempJob.job_description };
                if (tempJob.requirements && tempJob.requirements.length > 0) {
                    item.requirements = { SS: tempJob.requirements };
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
                item.dates = { SS: consultingJob.dates };
                item.hours_per_day = { N: consultingJob.hours_per_day.toString() };
                item.total_days = { N: consultingJob.total_days.toString() };
                item.meal_break = { BOOL: consultingJob.meal_break ?? false };
                item.hourly_rate = { N: consultingJob.hourly_rate.toString() };
                if (consultingJob.start_time) item.start_time = { S: consultingJob.start_time };
                if (consultingJob.end_time) item.end_time = { S: consultingJob.end_time };
                if (consultingJob.project_duration) item.project_duration = { S: consultingJob.project_duration };
                if (consultingJob.job_title) item.job_title = { S: consultingJob.job_title };
                if (consultingJob.job_description) item.job_description = { S: consultingJob.job_description };
                if (consultingJob.requirements && consultingJob.requirements.length > 0) {
                    item.requirements = { SS: consultingJob.requirements };
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
                item.job_title = { S: permanentJob.job_title };
                item.job_description = { S: permanentJob.job_description };
                item.employment_type = { S: permanentJob.employment_type };
                item.salary_min = { N: permanentJob.salary_min.toString() };
                item.salary_max = { N: permanentJob.salary_max.toString() };
                item.benefits = { SS: permanentJob.benefits }; // Benefits is guaranteed array by validation
                if (permanentJob.vacation_days !== undefined) {
                    item.vacation_days = { N: permanentJob.vacation_days.toString() };
                }
                if (permanentJob.work_schedule) {
                    item.work_schedule = { S: permanentJob.work_schedule };
                }
                if (permanentJob.start_date) {
                    item.start_date = { S: permanentJob.start_date };
                }
                if (permanentJob.requirements && permanentJob.requirements.length > 0) {
                    item.requirements = { SS: permanentJob.requirements };
                }
                responseData = {
                    ...responseData,
                    employment_type: permanentJob.employment_type,
                    salary_range: `$${permanentJob.salary_min.toLocaleString()} - $${permanentJob.salary_max.toLocaleString()}`,
                    benefits: permanentJob.benefits
                };
                break;
        }

        // 8. Save the job posting in DynamoDB
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE, // Assumed ENV var
            Item: item
        }));

        // 9. Final response
        return {
            statusCode: 201,
            body: JSON.stringify(responseData),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*', // Add CORS to response
            }
        };

    } catch (error) {
        const err = error as Error;
        console.error("Error creating job posting:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: err.message || "An unexpected error occurred" }),
            headers: {
                'Content-Type': 'application/json',
                'Access-Control-Allow-Origin': '*',
            }
        };
    }
};