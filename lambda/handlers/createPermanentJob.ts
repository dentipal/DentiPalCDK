import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    GetItemCommandInput,
    PutItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";

// Assuming these modules exist and export the correct functions/values
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// We must assume the type and existence of VALID_ROLE_VALUES
// import { VALID_ROLE_VALUES } from "./professionalRoles"; 
declare const VALID_ROLE_VALUES: string[];

// Initialize the DynamoDB client
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const dynamodb = new DynamoDBClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions for Job Data ---

interface BaseJobData {
    job_type: "temporary" | "multi_day_consulting" | "permanent";
    professional_role: string;
    shift_speciality: string;
    clinicIds: string[];
    job_title?: string;
    job_description?: string;
    requirements?: string[];
    [key: string]: any; // Allow other properties
}

interface TemporaryJobData extends BaseJobData {
    job_type: "temporary";
    date: string;
    hours: number;
    hourly_rate: number;
}

interface PermanentJobData extends BaseJobData {
    job_type: "permanent";
    employment_type: "full_time" | "part_time";
    salary_min: number;
    salary_max: number;
    benefits: string[]; // String Set in DynamoDB
    vacation_days?: number;
    work_schedule?: string;
    start_date?: string;
}

type JobData = TemporaryJobData | PermanentJobData;

// --- Group Helpers ---

function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    const claims = event?.requestContext?.authorizer?.claims || {};
    let raw: unknown = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
    
    if (Array.isArray(raw)) return raw.map(String);
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        
        if (val.startsWith("[") && val.endsWith("]")) {
            try { 
                const arr = JSON.parse(val); 
                return Array.isArray(arr) ? arr.map(String) : []; 
            } catch {}
        }
        return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [];
}

const normalizeGroup = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, ""); 
const ALLOWED_GROUPS: Set<string> = new Set(["root", "clinicadmin", "clinicmanager"]);

// --- Validation Helpers ---

const validateTemporaryJob = (jobData: any): string | null => {
    if (!jobData.date || jobData.hours === undefined || jobData.hourly_rate === undefined) {
        return "Temporary job requires: date, hours, hourly_rate";
    }
    
    const jobDate = new Date(jobData.date);
    if (isNaN(jobDate.getTime())) {
        return "Invalid date format. Use ISO date string.";
    }
    
    const hours = Number(jobData.hours);
    const hourlyRate = Number(jobData.hourly_rate);

    if (hours < 1 || hours > 12 || !Number.isFinite(hours)) {
        return "Hours must be a number between 1 and 12";
    }
    if (hourlyRate < 10 || hourlyRate > 200 || !Number.isFinite(hourlyRate)) {
        return "Hourly rate must be a number between $10 and $200";
    }
    return null;
};

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

// --- Small Helpers ---

/**
 * Fetches a clinic profile item by its composite key (clinicId, userSub).
 * @param clinicId The clinic ID.
 * @param userSub The userSub associated with the profile row.
 * @returns The DynamoDB Item or null.
 */
async function getClinicProfileByUser(clinicId: string, userSub: string): Promise<Record<string, AttributeValue> | null> {
    const getItemInput: GetItemCommandInput = {
        TableName: process.env.CLINIC_PROFILES_TABLE,
        Key: { clinicId: { S: clinicId }, userSub: { S: userSub } }
    };
    const res = await dynamodb.send(new GetItemCommand(getItemInput));
    return res.Item || null;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        const userSub: string = await validateToken(event as any); // clinic user

        // ---- Group authorization (Root, ClinicAdmin, ClinicManager only) ----
        const rawGroups: string[] = parseGroupsFromAuthorizer(event);
        const normalized: string[] = rawGroups.map(normalizeGroup);
        const isAllowed: boolean = normalized.some(g => ALLOWED_GROUPS.has(g));
        
        if (!isAllowed) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { requiredGroups: ["Root", "ClinicAdmin", "ClinicManager"], userGroups: rawGroups },
                timestamp: new Date().toISOString()
            });
        }
        // --------------------------------------------------------------------

        const jobData: JobData = JSON.parse(event.body || "{}");

        // Validate common required fields
        if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality || !jobData.clinicIds || !Array.isArray(jobData.clinicIds) || jobData.clinicIds.length === 0) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Missing required fields",
                details: { requiredFields: ["job_type", "professional_role", "shift_speciality", "clinicIds"] },
                timestamp: new Date().toISOString()
            });
        }

        // Validate job type
        const validJobTypes = ["temporary", "multi_day_consulting", "permanent"];
        if (!validJobTypes.includes(jobData.job_type)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid job type",
                details: { validTypes: validJobTypes, providedType: jobData.job_type },
                timestamp: new Date().toISOString()
            });
        }

        // Validate professional role
        if (!VALID_ROLE_VALUES || !VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES || [], providedRole: jobData.professional_role },
                timestamp: new Date().toISOString()
            });
        }

        // Job type specific validation
        let validationError: string | null = null;
        switch (jobData.job_type) {
            case "temporary":
                validationError = validateTemporaryJob(jobData);
                break;
            case "permanent":
                validationError = validatePermanentJob(jobData);
                break;
            // Note: multi_day_consulting validation is intentionally omitted here 
            // as its logic is handled by a separate handler (create-multi-day-consulting.ts).
        }

        if (validationError) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job validation failed",
                details: { validationError, jobType: jobData.job_type },
                timestamp: new Date().toISOString()
            });
        }

        const timestamp: string = new Date().toISOString();
        const jobIds: string[] = []; // To store the generated jobIds for all clinics

        // Loop through each clinicId and post the job
        const postJobsPromises = jobData.clinicIds.map(async (clinicId: string) => {
            const jobId: string = uuidv4(); // unique per clinic
            jobIds.push(jobId);

            // Fetch clinic (address + owner)
            const clinicGetItemInput: GetItemCommandInput = {
                TableName: process.env.CLINICS_TABLE,
                Key: { clinicId: { S: clinicId } }
            };

            const clinicResponse = await dynamodb.send(new GetItemCommand(clinicGetItemInput));
            
            if (!clinicResponse.Item) {
                // Throwing inside a Promise.all map is caught by the outer try/catch
                throw new Error(`Clinic not found: ${clinicId}`);
            }

            const clinicItem = clinicResponse.Item;
            
            // Extract and clean clinic address data
            const clinicAddress = {
                addressLine1: clinicItem.addressLine1?.S || "",
                addressLine2: clinicItem.addressLine2?.S || "",
                fullAddress: `${clinicItem.addressLine1?.S || ""} ${clinicItem.addressLine2?.S || ""}`.replace(/\s+/g, " ").trim(),
                city: clinicItem.city?.S || "",
                state: clinicItem.state?.S || "",
                pincode: clinicItem.pincode?.S || ""
            };
            const clinicOwnerSub: string | undefined = clinicItem.createdBy?.S;

            // Fetch clinic profile: try current user first, then owner; otherwise defaults
            let profileItem: Record<string, AttributeValue> | null = await getClinicProfileByUser(clinicId, userSub);
            
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                try {
                    profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
                } catch {} // Ignore error, fall back to defaults
            }

            const p = profileItem || {};
            // Extract and map profile data with fallback defaults
            const profileData = {
                bookingOutPeriod: p.bookingOutPeriod?.S || p.booking_out_period?.S || "immediate",
                clinicSoftware: p.softwareUsed?.S || p.software_used?.S || "Unknown",
                freeParkingAvailable: p.free_parking_available?.BOOL || false,
                parkingType: p.parking_type?.S || "N/A",
                practiceType: p.practiceType?.S || p.practice_type?.S || "General",
                primaryPracticeArea: p.primaryPracticeArea?.S || p.primary_practice_area?.S || "General Dentistry"
            };

            // Build base job posting item for DynamoDB
            const item: Record<string, AttributeValue> = {
                clinicId: { S: clinicId },
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
                job_type: { S: jobData.job_type },
                professional_role: { S: jobData.professional_role },
                shift_speciality: { S: jobData.shift_speciality },
                status: { S: "active" },
                createdAt: { S: timestamp },
                updatedAt: { S: timestamp },
                addressLine1: { S: clinicAddress.addressLine1 },
                addressLine2: { S: clinicAddress.addressLine2 },
                fullAddress: { S: clinicAddress.fullAddress },
                city: { S: clinicAddress.city },
                state: { S: clinicAddress.state },
                pincode: { S: clinicAddress.pincode },
                bookingOutPeriod: { S: profileData.bookingOutPeriod },
                clinicSoftware: { S: profileData.clinicSoftware },
                freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
                parkingType: { S: profileData.parkingType },
                practiceType: { S: profileData.practiceType },
                primaryPracticeArea: { S: profileData.primaryPracticeArea }
            };

            // Optional fields shared across types
            if (jobData.job_title) item.job_title = { S: jobData.job_title };
            if (jobData.job_description) item.job_description = { S: jobData.job_description };
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = { SS: jobData.requirements };
            }

            // Job type specific fields
            if (jobData.job_type === "temporary") {
                const tempJobData = jobData as TemporaryJobData;
                item.date = { S: tempJobData.date };
                item.hours = { N: String(tempJobData.hours) };
                item.hourly_rate = { N: String(tempJobData.hourly_rate) };
                // Add any other temporary-specific fields if needed in the future
            }
            
            if (jobData.job_type === "permanent") {
                const permJobData = jobData as PermanentJobData;
                item.employment_type = { S: permJobData.employment_type };
                item.salary_min = { N: String(permJobData.salary_min) };
                item.salary_max = { N: String(permJobData.salary_max) };
                item.benefits = { SS: permJobData.benefits };
                if (permJobData.vacation_days !== undefined) {
                    item.vacation_days = { N: String(permJobData.vacation_days) };
                }
                if (permJobData.work_schedule) {
                    item.work_schedule = { S: permJobData.work_schedule };
                }
                if (permJobData.start_date) {
                    item.start_date = { S: permJobData.start_date };
                }
            }
            
            // Insert the job into DynamoDB
            const putItemInput: PutItemCommandInput = {
                TableName: process.env.JOB_POSTINGS_TABLE,
                Item: item
            };
            await dynamodb.send(new PutItemCommand(putItemInput));
        });

        await Promise.all(postJobsPromises);

        return json(201, {
            status: "success",
            statusCode: 201,
            message: "Job postings created successfully",
            data: {
                jobIds: jobIds,
                jobType: jobData.job_type,
                clinicsCount: jobData.clinicIds.length,
                createdAt: timestamp
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error creating job posting:", err);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to create job postings",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};

exports.handler = handler;