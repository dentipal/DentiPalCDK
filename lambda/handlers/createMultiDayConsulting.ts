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
import { VALID_ROLE_VALUES } from "./professionalRoles"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const dynamodb = new DynamoDBClient({ region: REGION });

const resp = (statusCode: number, data: any): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS, // ✅ Uses imported headers
    body: typeof data === "string" ? data : JSON.stringify(data),
});

// ---------- Helper Functions ----------
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

// Fetch clinic profile by clinicId and userSub
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
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    // APIGatewayProxyEvent is strictly for REST API (v1), hence the type error without the cast.
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;
    
    // ✅ Uses imported headers
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

    try {
        // Auth
        const userSub: string = await validateToken(event as any);

        // Group authorization (Root, ClinicAdmin, ClinicManager only)
        const rawGroups: string[] = parseGroupsFromAuthorizer(event);
        const normalizedGroups: string[] = rawGroups.map(normalizeGroup);
        const isAllowed: boolean = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));
        
        if (!isAllowed) {
            return resp(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { requiredGroups: ["Root", "ClinicAdmin", "ClinicManager"], userGroups: rawGroups },
                timestamp: new Date().toISOString()
            });
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
                error: "Bad Request",
                statusCode: 400,
                message: "Missing required fields",
                details: {
                    requiredFields: ["clinicIds", "professional_role", "dates", "shift_speciality", "hours_per_day", "hourly_rate", "total_days", "start_time", "end_time"]
                },
                timestamp: new Date().toISOString()
            });
        }

        // Professional role validation
        if (typeof VALID_ROLE_VALUES === 'undefined' || !VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES || [], providedRole: jobData.professional_role },
                timestamp: new Date().toISOString()
            });
        }

        // Dates validation
        if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Dates array is required",
                details: { providedDates: jobData.dates },
                timestamp: new Date().toISOString()
            });
        }
        if (jobData.dates.length > 30) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Too many dates",
                details: { maxDays: 30, providedDays: jobData.dates.length },
                timestamp: new Date().toISOString()
            });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (const d of jobData.dates) {
            const dt = new Date(d);
            if (isNaN(dt.getTime())) return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid date format",
                details: { invalidDate: d, expectedFormat: "ISO 8601 date string" },
                timestamp: new Date().toISOString()
            });
            if (dt < today) return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "All dates must be in the future",
                details: { invalidDate: d, today: today.toISOString() },
                timestamp: new Date().toISOString()
            });
        }

        const uniqueDates = new Set(jobData.dates);
        if (uniqueDates.size !== jobData.dates.length) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Duplicate dates not allowed",
                details: { uniqueDates: uniqueDates.size, providedDates: jobData.dates.length },
                timestamp: new Date().toISOString()
            });
        }

        if (jobData.dates.length !== jobData.total_days) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Dates count must match total_days",
                details: { datesCount: jobData.dates.length, totalDays: jobData.total_days },
                timestamp: new Date().toISOString()
            });
        }

        // Numeric and range validation
        const hoursPerDay = Number(jobData.hours_per_day);
        const hourlyRate = Number(jobData.hourly_rate);
        
        if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 12) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid hours per day",
                details: { providedHours: jobData.hours_per_day, validRange: "1-12" },
                timestamp: new Date().toISOString()
            });
        }
        if (!Number.isFinite(hourlyRate) || hourlyRate < 10 || hourlyRate > 300) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid hourly rate",
                details: { providedRate: `$${jobData.hourly_rate}`, validRange: "$10-$300" },
                timestamp: new Date().toISOString()
            });
        }

        // ---------- meal_break: generic string + optional minutes ----------
        const mealBreakRaw = typeof jobData.meal_break === "string" ? normalizeWs(jobData.meal_break) : "";
        if (mealBreakRaw && mealBreakRaw.length > 100) {
            return resp(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Meal break description too long",
                details: { maxLength: 100, providedLength: mealBreakRaw.length },
                timestamp: new Date().toISOString()
            });
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
            status: "success",
            statusCode: 201,
            message: "Multi-day consulting projects created successfully",
            data: {
                jobIds,
                jobType: "multi_day_consulting",
                professionalRole: jobData.professional_role,
                dates: sortedDates,
                totalDays: jobData.total_days,
                hoursPerDay: hoursPerDay,
                hourlyRate: hourlyRate,
                mealBreak: mealBreakRaw || null,
                mealBreakMinutes: mealBreakMinutes,
                totalHours: totalHours,
                totalCompensation: `$${totalPay.toLocaleString()}`,
                startDate: sortedDates[0],
                endDate: sortedDates[sortedDates.length - 1]
            },
            timestamp: new Date().toISOString()
        });
    } catch (error) {
        // Handle Errors
        const err = error as Error & { message?: string };
        console.error("Error creating multi-day consulting project:", err);
        return resp(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to create multi-day consulting projects",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};

exports.handler = handler;