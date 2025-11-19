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
// Ensure that './professionalRoles' is a valid path to a file exporting an array of strings
// We must assume the type based on usage:
declare const VALID_ROLE_VALUES: string[];
// import { VALID_ROLE_VALUES } from "./professionalRoles"; 

// Initialize the DynamoDB client
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const dynamodb = new DynamoDBClient({ region: REGION });

// Define the type for CORS headers
type CorsHeaders = Record<string, string>;

// ---------- CORS helpers ----------
const CORS_HEADERS: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
    "Content-Type": "application/json",
};

/**
 * Helper to construct the API Gateway response object.
 * @param statusCode The HTTP status code.
 * @param data The response body data (object or string).
 * @returns APIGatewayProxyResult object.
 */
const resp = (statusCode: number, data: any): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: typeof data === "string" ? data : JSON.stringify(data),
});

// ---------- group helpers ----------
/**
 * Parses Cognito user groups from the API Gateway event authorizer claims.
 * @param event The API Gateway Proxy Event.
 * @returns An array of string group names.
 */
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

const normalizeGroup = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, ""); // "Clinic Manager" -> "clinicmanager"
const ALLOWED_GROUPS: Set<string> = new Set(["root", "clinicadmin", "clinicmanager"]);

// ---------- misc helpers ----------
const normalizeWs = (s: string | undefined | null = ""): string => String(s).replace(/\s+/g, " ").trim();

/** Try to parse a human string into minutes. Returns number or null if unknown. */
function parseMealBreakMinutes(input: string | undefined | null): number | null {
    if (!input) return null;
    const s = input.trim();

    // common "no break" variants
    if (/^(no(\s*break)?|none|n\/?a|nil)$/i.test(s)) return 0;

    // HH:MM (e.g., 01:00, 0:30)
    let m = s.match(/^(\d{1,2}):([0-5]?\d)$/);
    if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

    const lower = s.toLowerCase();

    // "1.5h", "1 h", "1 hour", "2 hours"
    m = lower.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
    if (m) return Math.round(parseFloat(m[1]) * 60);

    // "90min", "30 minutes"
    m = lower.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)$/);
    if (m) return Math.round(parseFloat(m[1]));

    // Just a bare number -> assume minutes (e.g., "30")
    m = lower.match(/^(\d+(?:\.\d+)?)$/);
    if (m) return Math.round(parseFloat(m[1]));

    return null; // keep original string only
}

/**
 * read one clinic profile row by composite key
 * @param clinicId The ID of the clinic.
 * @param userSub The userSub of the profile owner.
 * @returns The DynamoDB Item or null.
 */
async function getClinicProfileByUser(clinicId: string, userSub: string): Promise<Record<string, AttributeValue> | null> {
    const getItemInput: GetItemCommandInput = {
        TableName: process.env.CLINIC_PROFILES_TABLE,
        Key: { clinicId: { S: clinicId }, userSub: { S: userSub } },
    };
    const res = await dynamodb.send(new GetItemCommand(getItemInput));
    return res.Item || null;
}

// Define the expected structure for the request body
interface JobData {
    clinicIds: string[]; 
    professional_role: string; 
    dates: string[]; 
    shift_speciality: string; 
    hours_per_day: number; 
    hourly_rate: number; 
    total_days: number; 
    start_time: string; 
    end_time: string; 
    meal_break?: string; // string or number
    project_duration?: string;
    job_title?: string;
    job_description?: string;
    requirements?: string[]; // SS in DynamoDB
}

// Define the structure for extracted clinic address details
interface ClinicAddress {
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    city: string;
    state: string;
    pincode: string;
}

// Define the structure for extracted clinic profile details
interface ProfileData {
    bookingOutPeriod: string;
    practiceType: string;
    primaryPracticeArea: string;
    clinicSoftware: string;
    freeParkingAvailable: boolean;
    parkingType: string;
}


// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event?.httpMethod || event?.requestContext?.http?.method;
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

    try {
        // Auth
        const userSub: string = await validateToken(event as any);

        // Group authorization (Root, ClinicAdmin, ClinicManager only)
        const rawGroups: string[] = parseGroupsFromAuthorizer(event);
        const normalizedGroups: string[] = rawGroups.map(normalizeGroup);
        const isAllowed: boolean = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));
        
        if (!isAllowed) {
            return resp(403, { error: "Access denied: only Root, ClinicAdmin, or ClinicManager can create consulting projects" });
        }

        const jobData: JobData = JSON.parse(event.body || "{}");

        // Required fields validation
        if (
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0 ||
            !jobData.professional_role ||
            !jobData.dates ||
            !jobData.shift_speciality ||
            jobData.hours_per_day === undefined || // Check for undefined/null/0
            jobData.hourly_rate === undefined ||
            jobData.total_days === undefined ||
            !jobData.start_time ||
            !jobData.end_time
        ) {
            return resp(400, {
                error:
                    "Required fields: clinicIds (array), professional_role, dates, shift_speciality, hours_per_day, hourly_rate, total_days, start_time, end_time",
            });
        }

        // Professional role validation
        // NOTE: VALID_ROLE_VALUES is assumed to be defined externally (like in the original JS)
        if (typeof VALID_ROLE_VALUES === 'undefined' || !VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return resp(400, { error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES ? VALID_ROLE_VALUES.join(", ") : "Unknown"}` });
        }

        // Dates validation
        if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
            return resp(400, { error: "Dates must be a non-empty array" });
        }
        if (jobData.dates.length > 30) {
            return resp(400, { error: "Maximum 30 days allowed for consulting projects" });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (const d of jobData.dates) {
            const dt = new Date(d);
            if (isNaN(dt.getTime())) return resp(400, { error: `Invalid date format: ${d}. Use ISO date string.` });
            if (dt < today) return resp(400, { error: `All dates must be in the future. Invalid date: ${d}` });
        }

        const uniqueDates = new Set(jobData.dates);
        if (uniqueDates.size !== jobData.dates.length) {
            return resp(400, { error: "Duplicate dates are not allowed" });
        }

        if (jobData.dates.length !== jobData.total_days) {
            return resp(400, {
                error: `Number of dates (${jobData.dates.length}) must match total_days (${jobData.total_days})`,
            });
        }

        // Numeric and range validation
        const hoursPerDay = Number(jobData.hours_per_day);
        const hourlyRate = Number(jobData.hourly_rate);
        
        if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 12) {
            return resp(400, { error: "Hours per day must be a number between 1 and 12" });
        }
        if (!Number.isFinite(hourlyRate) || hourlyRate < 10 || hourlyRate > 300) {
            return resp(400, { error: "Hourly rate must be a number between $10 and $300 for consulting" });
        }

        // ---------- meal_break: generic string + optional minutes ----------
        const mealBreakRaw = typeof jobData.meal_break === "string" ? normalizeWs(jobData.meal_break) : "";
        if (mealBreakRaw && mealBreakRaw.length > 100) {
            return resp(400, { error: "meal_break must be 100 characters or fewer" });
        }
        const mealBreakMinutes = mealBreakRaw ? parseMealBreakMinutes(mealBreakRaw) : null;
        // ------------------------------------------------------------------

        const timestamp: string = new Date().toISOString();
        const sortedDates: string[] = [...jobData.dates].sort();
        const jobIds: string[] = []; // To store the generated jobIds for all clinics

        // Loop through each clinicId and post the job
        const postJobsPromises = jobData.clinicIds.map(async (clinicId: string) => {
            const jobId: string = uuidv4(); // Generate unique job ID for each clinic
            jobIds.push(jobId); // Collect jobId for response

            // Fetch clinic address & owner
            const clinicGetItemInput: GetItemCommandInput = {
                TableName: process.env.CLINICS_TABLE,
                Key: { clinicId: { S: clinicId } },
            };
            const clinicResponse = await dynamodb.send(new GetItemCommand(clinicGetItemInput));
            
            if (!clinicResponse.Item) throw new Error(`Clinic not found: ${clinicId}`);

            const clinicAddress: ClinicAddress = {
                addressLine1: clinicResponse.Item.addressLine1?.S || "",
                addressLine2: clinicResponse.Item.addressLine2?.S || "",
                addressLine3: clinicResponse.Item.addressLine3?.S || "",
                city: clinicResponse.Item.city?.S || "",
                state: clinicResponse.Item.state?.S || "",
                pincode: clinicResponse.Item.pincode?.S || "",
            };
            const clinicOwnerSub: string | undefined = clinicResponse.Item.createdBy?.S;

            // Fetch clinic profile: try manager's row -> fallback to clinic owner's row -> defaults
            let profileItem: Record<string, AttributeValue> | null = await getClinicProfileByUser(clinicId, userSub);
            
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                try {
                    profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
                } catch (e) {
                    console.warn(`Failed to fetch clinic owner profile for ${clinicOwnerSub}:`, (e as Error).message);
                }
            }
            
            const p = profileItem || {};
            const profileData: ProfileData = {
                bookingOutPeriod: p.booking_out_period?.S || "immediate",
                practiceType: p.practice_type?.S || "General",
                primaryPracticeArea: p.primary_practice_area?.S || "General Dentistry",
                clinicSoftware: p.clinic_software?.S || p.software_used?.S || "Unknown",
                freeParkingAvailable: p.free_parking_available?.BOOL || false,
                parkingType: p.parking_type?.S || "N/A",
            };

            // Build dynamo item
            const item: Record<string, AttributeValue> = {
                clinicId: { S: clinicId },
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
                job_type: { S: "multi_day_consulting" },
                professional_role: { S: jobData.professional_role },
                dates: { L: sortedDates.map(d => ({ S: d })) },
                shift_speciality: { S: jobData.shift_speciality },
                hours_per_day: { N: String(hoursPerDay) },
                total_days: { N: String(jobData.total_days) },
                hourly_rate: { N: String(hourlyRate) },
                start_time: { S: jobData.start_time },
                end_time: { S: jobData.end_time },
                status: { S: "active" },
                createdAt: { S: timestamp },
                updatedAt: { S: timestamp },
                addressLine1: { S: clinicAddress.addressLine1 },
                addressLine2: { S: clinicAddress.addressLine2 },
                addressLine3: { S: clinicAddress.addressLine3 },
                city: { S: clinicAddress.city },
                state: { S: clinicAddress.state },
                pincode: { S: clinicAddress.pincode },
                fullAddress: {
                    S: `${clinicAddress.addressLine1} ${clinicAddress.addressLine2} ${clinicAddress.addressLine3}, ${clinicAddress.city}, ${clinicAddress.state} ${clinicAddress.pincode}`.replace(/\s+/g, " ").trim(),
                },
                bookingOutPeriod: { S: profileData.bookingOutPeriod },
                practiceType: { S: profileData.practiceType },
                primaryPracticeArea: { S: profileData.primaryPracticeArea },
                clinicSoftware: { S: profileData.clinicSoftware },
                freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
                parkingType: { S: profileData.parkingType },
            };

            // Only add meal_break attributes if provided
            if (mealBreakRaw) {
                item.meal_break = { S: mealBreakRaw };
                if (mealBreakMinutes !== null) {
                    item.meal_break_minutes = { N: String(mealBreakMinutes) };
                }
            }

            // Add optional fields
            if (jobData.project_duration) item.project_duration = { S: jobData.project_duration };
            if (jobData.job_title) item.job_title = { S: jobData.job_title };
            if (jobData.job_description) item.job_description = { S: jobData.job_description };
            if (Array.isArray(jobData.requirements) && jobData.requirements.length > 0) {
                item.requirements = { SS: jobData.requirements };
            }

            // Put item into the job postings table
            const putItemInput: PutItemCommandInput = { 
                TableName: process.env.JOB_POSTINGS_TABLE, 
                Item: item 
            };
            await dynamodb.send(new PutItemCommand(putItemInput));
        });

        // Wait for all jobs to be posted
        await Promise.all(postJobsPromises);

        // Calculate totals for response
        const totalHours = Number(jobData.total_days) * hoursPerDay;
        const totalPay = totalHours * hourlyRate;

        // Return successful response
        return resp(201, {
            message: "Multi-day consulting projects created successfully for multiple clinics",
            jobIds,
            job_type: "multi_day_consulting",
            professional_role: jobData.professional_role,
            dates: sortedDates,
            total_days: jobData.total_days,
            hours_per_day: hoursPerDay,
            hourly_rate: hourlyRate,
            meal_break: mealBreakRaw || null,
            meal_break_minutes: mealBreakMinutes, // nullable
            total_hours: totalHours,
            total_compensation: `$${totalPay.toLocaleString()}`,
            start_date: sortedDates[0],
            end_date: sortedDates[sortedDates.length - 1],
        });
    } catch (error) {
        // Handle Errors
        const err = error as Error & { message?: string };
        console.error("Error creating multi-day consulting project:", err);
        return resp(500, { error: err.message || "Internal Server Error" });
    }
};

exports.handler = handler;