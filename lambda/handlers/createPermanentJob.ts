import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
// We assume this util exists, but we also add a fallback to read from requestContext like your JS code
import { extractUserFromBearerToken } from "./utils"; 
import { VALID_ROLE_VALUES } from "./professionalRoles"; 

// --- Configuration ---
const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// --- Initialization ---
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- CORS Headers (Matched to your JS code) ---
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
};

// --- Helper Functions (Ported from your JS Code) ---

// 1. Exact Group Parser from your working JS code
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    const claims = (event.requestContext as any)?.authorizer?.claims || {};
    let raw = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";

    if (Array.isArray(raw)) return raw.map(String);
    
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        // Handle stringified arrays like "[Root, ClinicAdmin]"
        if (val.startsWith("[") && val.endsWith("]")) {
            try {
                const arr = JSON.parse(val);
                return Array.isArray(arr) ? arr.map(String) : [];
            } catch { }
        }
        return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [];
}

const normalizeGroup = (g: string) => g.toLowerCase().replace(/[^a-z0-9]/g, ""); 
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);

// 2. Profile Fetcher
async function getClinicProfileByUser(clinicId: string, userSub: string): Promise<Record<string, any> | null> {
    try {
        const res = await ddbDoc.send(new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId, userSub }
        }));
        return res.Item || null;
    } catch (e) {
        return null;
    }
}

// 3. Validation Logic
const validatePermanentJob = (jobData: any): string | null => {
    if (!jobData.employment_type || !jobData.salary_min || !jobData.salary_max || !jobData.benefits) {
        return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
    }
    
    // Ensure numbers
    const min = Number(jobData.salary_min);
    const max = Number(jobData.salary_max);

    if (max < min) {
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

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle OPTIONS preflight
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- 1. Authentication & Group Check (Matches JS Logic) ---
        
        // A. Get User Sub
        let userSub: string = "";
        try {
            // Try your util first
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (e) {
            // Fallback: Try to get sub from authorizer like the JS code does
            const claims = (event.requestContext as any)?.authorizer?.claims;
            if (claims && claims.sub) {
                userSub = claims.sub;
            } else {
                throw new Error("Invalid access token");
            }
        }

        // B. Get Groups (Using the specific parser from JS code)
        const rawGroups = parseGroupsFromAuthorizer(event);
        
        // C. Check Permissions
        const normalized = rawGroups.map(normalizeGroup);
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));

        if (!isAllowed) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Access denied: only Root, ClinicAdmin, or ClinicManager can create jobs" })
            };
        }

        // --- 2. Parse Body & Validate ---
        
        const jobData = JSON.parse(event.body || "{}");

        // Common Fields
        if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality || !jobData.clinicIds || !Array.isArray(jobData.clinicIds)) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Required fields: job_type, professional_role, shift_speciality, clinicIds (array)" })
            };
        }

        // Type Check
        if (jobData.job_type !== "permanent") {
             return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Invalid job_type. This endpoint is for permanent jobs." })
            };
        }

        // Role Check
        if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(", ")}` })
            };
        }

        // Permanent Validation
        const validationError = validatePermanentJob(jobData);
        if (validationError) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: validationError })
            };
        }

        // --- 3. Process Clinics (Loop) ---

        const timestamp = new Date().toISOString();
        const jobIds: string[] = [];

        const postJobsPromises = jobData.clinicIds.map(async (clinicId: string) => {
            const jobId = uuidv4();
            jobIds.push(jobId);

            // Fetch Clinic
            const clinicResponse = await ddbDoc.send(new GetCommand({
                TableName: CLINICS_TABLE,
                Key: { clinicId }
            }));

            if (!clinicResponse.Item) {
                throw new Error(`Clinic not found: ${clinicId}`);
            }

            const clinicItem = clinicResponse.Item;
            
            // Extract Address
            const clinicAddress = {
                addressLine1: clinicItem.addressLine1 || "",
                addressLine2: clinicItem.addressLine2 || "",
                fullAddress: `${clinicItem.addressLine1 || ""} ${clinicItem.addressLine2 || ""}`.replace(/\s+/g, " ").trim(),
                city: clinicItem.city || "",
                state: clinicItem.state || "",
                pincode: clinicItem.pincode || ""
            };
            const clinicOwnerSub = clinicItem.createdBy;

            // Fetch Profile
            let profileItem = await getClinicProfileByUser(clinicId, userSub);
            if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
                profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
            }

            const p = profileItem || {};
            // Profile Defaults (handling both snake_case and camelCase to be safe)
            const profileData = {
                bookingOutPeriod: p.bookingOutPeriod || p.booking_out_period || "immediate",
                clinicSoftware: p.softwareUsed || p.software_used || "Unknown",
                freeParkingAvailable: p.free_parking_available ?? false,
                parkingType: p.parking_type || "N/A",
                practiceType: p.practiceType || p.practice_type || "General",
                primaryPracticeArea: p.primaryPracticeArea || p.primary_practice_area || "General Dentistry"
            };

            // Build Item (Using DocumentClient syntax - cleaner!)
            const item: Record<string, any> = {
                clinicId: clinicId,
                clinicUserSub: userSub,
                jobId: jobId,
                job_type: "permanent",
                professional_role: jobData.professional_role,
                shift_speciality: jobData.shift_speciality,
                status: "active",
                createdAt: timestamp,
                updatedAt: timestamp,
                
                // Address
                addressLine1: clinicAddress.addressLine1,
                addressLine2: clinicAddress.addressLine2,
                fullAddress: clinicAddress.fullAddress,
                city: clinicAddress.city,
                state: clinicAddress.state,
                pincode: clinicAddress.pincode,

                // Profile
                bookingOutPeriod: profileData.bookingOutPeriod,
                clinicSoftware: profileData.clinicSoftware,
                freeParkingAvailable: profileData.freeParkingAvailable,
                parkingType: profileData.parkingType,
                practiceType: profileData.practiceType,
                primaryPracticeArea: profileData.primaryPracticeArea,

                // Permanent Specifics
                employment_type: jobData.employment_type,
                salary_min: Number(jobData.salary_min),
                salary_max: Number(jobData.salary_max),
                benefits: new Set(jobData.benefits), // Set automatically maps to SS
            };

            // Optional fields
            if (jobData.job_title) item.job_title = jobData.job_title;
            if (jobData.job_description) item.job_description = jobData.job_description;
            if (jobData.vacation_days) item.vacation_days = Number(jobData.vacation_days);
            if (jobData.work_schedule) item.work_schedule = jobData.work_schedule;
            if (jobData.start_date) item.start_date = jobData.start_date;
            if (jobData.requirements && jobData.requirements.length > 0) {
                item.requirements = new Set(jobData.requirements);
            }

            // Save
            await ddbDoc.send(new PutCommand({
                TableName: JOB_POSTINGS_TABLE,
                Item: item
            }));
        });

        await Promise.all(postJobsPromises);

        return {
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Permanent job postings created successfully",
                jobIds: jobIds
            })
        };

    } catch (error: any) {
        console.error("Error creating job posting:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: error.message || "Internal Server Error" })
        };
    }
};