import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { VALID_ROLE_VALUES } from "./professionalRoles";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. Configuration ---
const REGION: string = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// Initialize V3 Client and Document Client
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

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

    return null; 
}

// Fetch clinic profile by clinicId and userSub
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

// --- 3. Type Definitions ---

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
    meal_break?: string; 
    project_duration?: string;
    job_title?: string;
    job_description?: string;
    requirements?: string[]; 
}

interface ClinicAddress {
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    city: string;
    state: string;
    pincode: string;
}

interface ProfileData {
    bookingOutPeriod: string;
    practiceType: string;
    primaryPracticeArea: string;
    clinicSoftware: string;
    freeParkingAvailable: boolean;
    parkingType: string;
}

// --- 4. Main Handler ---

const ALLOWED_GROUPS: Set<string> = new Set(["root", "clinicadmin", "clinicmanager"]);

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication (Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        const groups = userInfo.groups || [];

        // 3. Group Authorization
        const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, "");
        const isAllowed = groups.some(g => ALLOWED_GROUPS.has(normalizeGroup(g)));

        if (!isAllowed) {
            return json(403, {
                error: "Forbidden",
                message: "Access denied",
                details: { requiredGroups: Array.from(ALLOWED_GROUPS), userGroups: groups }
            });
        }

        // 4. Parse Body
        const jobData: JobData = JSON.parse(event.body || "{}");

        // 5. Required fields validation
        if (
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0 ||
            !jobData.professional_role ||
            !jobData.dates ||
            !jobData.shift_speciality ||
            jobData.hours_per_day === undefined || 
            jobData.hourly_rate === undefined ||
            jobData.total_days === undefined ||
            !jobData.start_time ||
            !jobData.end_time
        ) {
            return json(400, {
                error: "Bad Request",
                message: "Missing required fields",
                details: {
                    requiredFields: ["clinicIds", "professional_role", "dates", "shift_speciality", "hours_per_day", "hourly_rate", "total_days", "start_time", "end_time"]
                }
            });
        }

        // Professional role validation
        if (typeof VALID_ROLE_VALUES === 'undefined' || !VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return json(400, {
                error: "Bad Request",
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES || [], providedRole: jobData.professional_role }
            });
        }

        // Dates validation
        if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
            return json(400, { error: "Bad Request", message: "Dates array is required" });
        }
        if (jobData.dates.length > 30) {
            return json(400, { error: "Bad Request", message: "Too many dates", details: { maxDays: 30 } });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);
        for (const d of jobData.dates) {
            const dt = new Date(d);
            if (isNaN(dt.getTime())) {
                return json(400, { error: "Bad Request", message: "Invalid date format", details: { invalidDate: d } });
            }
            if (dt < today) {
                return json(400, { error: "Bad Request", message: "All dates must be in the future", details: { invalidDate: d } });
            }
        }

        const uniqueDates = new Set(jobData.dates);
        if (uniqueDates.size !== jobData.dates.length) {
            return json(400, { error: "Bad Request", message: "Duplicate dates not allowed" });
        }

        if (jobData.dates.length !== jobData.total_days) {
            return json(400, { error: "Bad Request", message: "Dates count must match total_days" });
        }

        // Numeric and range validation
        const hoursPerDay = Number(jobData.hours_per_day);
        const hourlyRate = Number(jobData.hourly_rate);
        
        if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 12) {
            return json(400, { error: "Bad Request", message: "Invalid hours per day (1-12)" });
        }
        if (!Number.isFinite(hourlyRate) || hourlyRate < 10 || hourlyRate > 300) {
            return json(400, { error: "Bad Request", message: "Invalid hourly rate ($10-$300)" });
        }

        // Meal break parsing
        const mealBreakRaw = typeof jobData.meal_break === "string" ? normalizeWs(jobData.meal_break) : "";
        if (mealBreakRaw && mealBreakRaw.length > 100) {
             return json(400, { error: "Bad Request", message: "Meal break description too long" });
        }
        const mealBreakMinutes = mealBreakRaw ? parseMealBreakMinutes(mealBreakRaw) : null;

        const timestamp: string = new Date().toISOString();
        const sortedDates: string[] = [...jobData.dates].sort();
        const jobIds: string[] = [];

        // 6. Post Jobs Loop
        const postJobsPromises = jobData.clinicIds.map(async (clinicId: string) => {
            const jobId: string = uuidv4();
            jobIds.push(jobId); 

            // Fetch clinic address & owner
            const clinicResponse = await ddbDoc.send(new GetCommand({
                TableName: CLINICS_TABLE,
                Key: { clinicId: clinicId },
            }));
            
            const clinicItem = clinicResponse.Item;
            if (!clinicItem) throw new Error(`Clinic not found: ${clinicId}`);

            const clinicAddress: ClinicAddress = {
                addressLine1: clinicItem.addressLine1 || "",
                addressLine2: clinicItem.addressLine2 || "",
                addressLine3: clinicItem.addressLine3 || "",
                city: clinicItem.city || "",
                state: clinicItem.state || "",
                pincode: clinicItem.pincode || "",
            };
            const clinicOwnerSub = clinicItem.createdBy;

            // Fetch clinic profile
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            
            // Fallback to clinic owner's profile if current user is a manager/delegate
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
            }
            
            const p = profileItem || {};
            const profileData: ProfileData = {
                bookingOutPeriod: p.booking_out_period || "immediate",
                practiceType: p.practice_type || "General",
                primaryPracticeArea: p.primary_practice_area || "General Dentistry",
                clinicSoftware: p.clinic_software || p.software_used || "Unknown",
                freeParkingAvailable: p.free_parking_available ?? false,
                parkingType: p.parking_type || "N/A",
            };

            // Build dynamo item (using plain Objects, DocumentClient handles marshalling)
            const item: Record<string, any> = {
                clinicId: clinicId,
                clinicUserSub: userSub,
                jobId: jobId,
                job_type: "multi_day_consulting",
                professional_role: jobData.professional_role,
                // DocumentClient marshalls arrays as Lists (L) by default, sets as SS if using Set
                dates: new Set(sortedDates), 
                shift_speciality: jobData.shift_speciality,
                hours_per_day: hoursPerDay,
                total_days: jobData.total_days,
                hourly_rate: hourlyRate,
                start_time: jobData.start_time,
                end_time: jobData.end_time,
                status: "active",
                createdAt: timestamp,
                updatedAt: timestamp,
                // Address
                addressLine1: clinicAddress.addressLine1,
                addressLine2: clinicAddress.addressLine2,
                addressLine3: clinicAddress.addressLine3,
                city: clinicAddress.city,
                state: clinicAddress.state,
                pincode: clinicAddress.pincode,
                fullAddress: `${clinicAddress.addressLine1} ${clinicAddress.addressLine2} ${clinicAddress.addressLine3}, ${clinicAddress.city}, ${clinicAddress.state} ${clinicAddress.pincode}`.replace(/\s+/g, " ").trim(),
                // Profile
                bookingOutPeriod: profileData.bookingOutPeriod,
                practiceType: profileData.practiceType,
                primaryPracticeArea: profileData.primaryPracticeArea,
                clinicSoftware: profileData.clinicSoftware,
                freeParkingAvailable: profileData.freeParkingAvailable,
                parkingType: profileData.parkingType,
            };

            // Optional fields
            if (mealBreakRaw) {
                item.meal_break = mealBreakRaw;
                if (mealBreakMinutes !== null) {
                    item.meal_break_minutes = mealBreakMinutes;
                }
            }
            if (jobData.project_duration) item.project_duration = jobData.project_duration;
            if (jobData.job_title) item.job_title = jobData.job_title;
            if (jobData.job_description) item.job_description = jobData.job_description;
            if (Array.isArray(jobData.requirements) && jobData.requirements.length > 0) {
                item.requirements = new Set(jobData.requirements);
            }

            // Put item
            await ddbDoc.send(new PutCommand({
                TableName: JOB_POSTINGS_TABLE, 
                Item: item 
            }));
        });

        // Wait for all jobs
        await Promise.all(postJobsPromises);

        // Calculate totals
        const totalHours = Number(jobData.total_days) * hoursPerDay;
        const totalPay = totalHours * hourlyRate;

        // 7. Response
        return json(201, {
            status: "success",
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
            timestamp: timestamp
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating multi-day consulting project:", err);
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to create multi-day consulting projects",
            details: { reason: err.message }
        });
    }
};