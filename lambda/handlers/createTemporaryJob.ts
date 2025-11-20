import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    AttributeValue,
    GetItemCommandOutput,
    GetItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
import { validateToken } from "./utils"; 
import { VALID_ROLE_VALUES } from "./professionalRoles"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Interface for the expected request body data structure (temporary job)
interface MultiJobData {
    clinicIds: string[]; // List of clinics to post to
    professional_role: string;
    date: string; // ISO date string
    shift_speciality: string;
    hours: number;
    hourly_rate: number;
    start_time: string;
    end_time: string;
    meal_break?: string; // Stored as string in original JS
    job_title?: string;
    job_description?: string;
    requirements?: string[]; // Array of strings
    assisted_hygiene?: boolean;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

/* ----------------- group helpers ----------------- */

/**
 * Parses Cognito groups from the Lambda event's authorizer claims.
 * @param event The API Gateway event.
 * @returns An array of group names.
 */
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    const claims = event?.requestContext?.authorizer?.claims || {};
    let raw = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
    if (Array.isArray(raw)) return raw as string[];
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        if (val.startsWith("[") && val.endsWith("]")) {
            try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr.filter(s => typeof s === 'string') : []; } catch { }
        }
        return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [];
}

const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, ""); // "Clinic Manager" -> "clinicmanager"
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

/* ------------------------------------------------- */

/**
 * Reads one clinic profile row by composite key (clinicId + userSub).
 * @param clinicId The ID of the clinic.
 * @param userSub The user's Cognito sub.
 * @returns The DynamoDB item or null.
 */
async function getClinicProfileByUser(clinicId: string, userSub: string): Promise<Record<string, AttributeValue> | null> {
    const res: GetItemCommandOutput = await dynamodb.send(
        new GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Key: { clinicId: { S: clinicId }, userSub: { S: userSub } },
        } as GetItemCommandInput) 
    );
    return res.Item || null;
}

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authorization
        const userSub: string = await validateToken(event as any); // This should be a clinic user

        // ---- Group authorization (Root, ClinicAdmin, ClinicManager only) ----
        const rawGroups = parseGroupsFromAuthorizer(event);
        const normalized = rawGroups.map(normalizeGroup);
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
        
        if (!isAllowed) {
            console.warn(`[AUTH] User ${userSub} is not in an allowed group. Groups: [${rawGroups.join(', ')}]`);
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied",
                details: { requiredGroups: ["Root", "ClinicAdmin", "ClinicManager"], userGroups: rawGroups },
                timestamp: new Date().toISOString()
            });
        }
        // --------------------------------------------------------------------

        const jobData: MultiJobData = JSON.parse(event.body || '{}');

        // 2. Validate Required Fields (Temporary Job Specifics)
        if (
            !jobData.clinicIds ||
            !Array.isArray(jobData.clinicIds) ||
            jobData.clinicIds.length === 0 ||
            !jobData.professional_role ||
            !jobData.date ||
            !jobData.shift_speciality ||
            jobData.hours === undefined ||
            jobData.hourly_rate === undefined ||
            !jobData.start_time ||
            !jobData.end_time
        ) {
            console.warn("[VALIDATION] Missing required fields in body.");
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Missing required fields",
                details: {
                    requiredFields: ["clinicIds", "professional_role", "date", "shift_speciality", "hours", "hourly_rate", "start_time", "end_time"]
                },
                timestamp: new Date().toISOString()
            });
        }

        // 3. Validate Data Integrity
        
        // Validate professional role
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            console.warn(`[VALIDATION] Invalid professional_role: ${jobData.professional_role}`);
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid professional role",
                details: { validRoles: VALID_ROLE_VALUES, providedRole: jobData.professional_role },
                timestamp: new Date().toISOString()
            });
        }

        // Validate date format and future
        const jobDate = new Date(jobData.date);
        if (isNaN(jobDate.getTime())) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid date format",
                details: { providedDate: jobData.date, expectedFormat: "ISO 8601 date string" },
                timestamp: new Date().toISOString()
            });
        }
        const today = new Date();
        today.setHours(0, 0, 0, 0); 
        if (jobDate < today) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job date must be in the future",
                details: { providedDate: jobData.date, minimumDate: today.toISOString() },
                timestamp: new Date().toISOString()
            });
        }

        // Validate hours and rate
        if (jobData.hours < 1 || jobData.hours > 12) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid hours value",
                details: { providedHours: jobData.hours, validRange: "1-12" },
                timestamp: new Date().toISOString()
            });
        }
        if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid hourly rate",
                details: { providedRate: `$${jobData.hourly_rate}`, validRange: "$10-$200" },
                timestamp: new Date().toISOString()
            });
        }

        const timestamp = new Date().toISOString();
        const jobIds: string[] = []; // To store the generated jobIds for all clinics

        // 4. Loop through each clinicId and post the job concurrently
        const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
            const jobId = uuidv4(); // Generate unique job ID for each clinic
            jobIds.push(jobId); // Collect jobId for response

            // Fetch clinic address details from CLINICS_TABLE
            const clinicResponse: GetItemCommandOutput = await dynamodb.send(new GetItemCommand({
                TableName: process.env.CLINICS_TABLE,
                Key: { clinicId: { S: clinicId } },
            }));
            
            const clinic = clinicResponse.Item;
            if (!clinic) {
                // Throwing here will stop Promise.all and trigger the catch block with the clinic error
                throw new Error(`Clinic not found: ${clinicId}`);
            }

            // Extract clinic address details safely
            const addressLine1 = clinic.addressLine1?.S || "";
            const addressLine2 = clinic.addressLine2?.S || "";
            const addressLine3 = clinic.addressLine3?.S || "";
            const city = clinic.city?.S || "";
            const state = clinic.state?.S || "";
            const pincode = clinic.pincode?.S || "";
            const clinicOwnerSub = clinic.createdBy?.S;
            
            // 5. Fetch profile details (for job metadata)
            // Try current user's profile first, then fall back to clinic owner's profile
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                 // Suppress error if fallback fails, as original JS used a try/catch
                 profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub).catch(() => null);
            }

            const p = profileItem || {};
            
            // Extract profile details safely with defaults
            const bookingOutPeriod = p.booking_out_period?.S || p.bookingOutPeriod?.S || "immediate";
            const clinicSoftware = p.clinic_software?.S || p.software_used?.S || "Unknown";
            const freeParkingAvailable = p.free_parking_available?.BOOL || false;
            const parkingType = p.parking_type?.S || "N/A";
            const primaryPracticeArea = p.primary_practice_area?.S || "General";
            const practiceType = p.practice_type?.S || "General";


            // 6. Build DynamoDB item using Record<string, AttributeValue>
            const item: Record<string, AttributeValue> = {
                clinicId: { S: clinicId },
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
                job_type: { S: "temporary" },
                professional_role: { S: jobData.professional_role },
                date: { S: jobData.date },
                shift_speciality: { S: jobData.shift_speciality },
                hours: { N: jobData.hours.toString() },
                meal_break: { S: jobData.meal_break || "" }, // Original stored as string, preserving logic
                hourly_rate: { N: jobData.hourly_rate.toString() },
                start_time: { S: jobData.start_time },
                end_time: { S: jobData.end_time },
                
                // Address details
                addressLine1: { S: addressLine1 },
                addressLine2: { S: addressLine2 },
                addressLine3: { S: addressLine3 },
                fullAddress: { 
                    S: `${addressLine1} ${addressLine2} ${addressLine3}, ${city}, ${state} ${pincode}`
                        .replace(/\s+/g, " ").trim() 
                },
                city: { S: city },
                state: { S: state },
                pincode: { S: pincode },
                
                // Profile details
                bookingOutPeriod: { S: bookingOutPeriod },
                clinicSoftware: { S: clinicSoftware },
                freeParkingAvailable: { BOOL: freeParkingAvailable },
                parkingType: { S: parkingType },
                practiceType: { S: practiceType },
                primaryPracticeArea: { S: primaryPracticeArea },
                
                // Job metadata
                status: { S: "active" },
                createdAt: { S: timestamp },
                updatedAt: { S: timestamp },
            };

            // Add optional fields
            if (jobData.job_title) item.job_title = { S: jobData.job_title };
            if (jobData.job_description) item.job_description = { S: jobData.job_description };
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = { SS: jobData.requirements };
            }
            if (jobData.assisted_hygiene !== undefined) {
                 // Original logic did not explicitly include assisted_hygiene, but it is standard for job posts
                 item.assisted_hygiene = { BOOL: jobData.assisted_hygiene };
            }


            // 7. Insert the job into DynamoDB
            await dynamodb.send(
                new PutItemCommand({
                    TableName: process.env.JOB_POSTINGS_TABLE,
                    Item: item,
                })
            );
        });

        // Wait for all jobs to be posted
        await Promise.all(postJobsPromises);

        // 8. Final success response
        const totalPay = jobData.hours * jobData.hourly_rate;

        return json(201, {
            status: "success",
            statusCode: 201,
            message: "Temporary job postings created successfully",
            data: {
                jobIds,
                jobType: "temporary",
                professionalRole: jobData.professional_role,
                date: jobData.date,
                hours: jobData.hours,
                hourlyRate: jobData.hourly_rate,
                totalPay: `$${totalPay.toFixed(2)}`
            },
            timestamp: new Date().toISOString()
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating temporary job postings:", err);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to create temporary job postings",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};