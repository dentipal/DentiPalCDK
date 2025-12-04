import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";
// ✅ UPDATE: Changed import to use the new token utility
import { extractUserFromBearerToken } from "./utils";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Type for the unmarshalled job item
interface UnmarshalledJobItem extends Record<string, any> {
    jobId?: string;
    job_type?: string;
    jobType?: string;
    // ... many other properties
    dates?: string[];
}

// Type for the structured date output
interface PermanentStartDate {
    startDate: string;
    source: string | null;
}

// Type for the final formatted response item
interface FormattedJobItem {
    jobId: string;
    jobType: string;
    professionalRole: string;
    shiftSpeciality: string;
    employmentType: string;
    salaryMin: number;
    salaryMax: number;
    benefits: any; // Using 'any' as the type is undefined in original
    status: string;
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    fullAddress: string;
    city: string;
    state: string;
    pincode: string;
    bookingOutPeriod: string;
    clinicSoftware: string;
    freeParkingAvailable: boolean;
    parkingType: string;
    practiceType: string;
    primaryPracticeArea: string;
    startDate: string;
    createdAt: string;
    updatedAt: string;
}

// --- helpers -------------------------------------------------

/**
 * Picks the first non-null/non-empty value from an object based on a list of keys.
 */
const pick = (obj: Record<string, any>, keys: string[]): { key: string | null, value: any } => {
    for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
            return { key: k, value: obj[k] };
        }
    }
    return { key: null, value: undefined };
};

/**
 * Attempts to convert a value (number, numeric string, or date string) into an ISO 8601 string.
 */
const toISO = (val: any): string => {
    if (val === undefined || val === null || val === "") return "";

    const strVal = String(val);

    // number or numeric string -> epoch ms
    if (typeof val === "number" || (/^\d+$/.test(strVal))) {
        const n = Number(val);
        if (!Number.isNaN(n)) {
            const d = new Date(n);
            // Check if parsing successful and epoch is valid (e.g., prevents Date(0) for malformed strings)
            if (!Number.isNaN(d.getTime())) return d.toISOString();
        }
    }
    
    // ISO/UTC/local date string
    const d = new Date(strVal);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
    
    // give back original if unparsable (at least user sees something)
    return strVal;
};

/**
 * Determines the permanent job's start date by checking common field names and falling back to the earliest date in a 'dates' array.
 */
const getPermanentStartDate = (job: UnmarshalledJobItem): PermanentStartDate => {
    // Common field name variants
    const { key, value } = pick(job, [
        "startDate", "start_date",
        "expectedStartDate", "expected_start_date",
        "joiningDate", "joining_date", "joinDate", "join_date",
        "availableFrom", "available_from",
        "availabilityDate", "availability_date",
        "startOn", "start_on",
        "start" // last resort
    ]);

    if (value !== undefined) {
        const iso = toISO(value);
        if (iso) {
            return { startDate: iso, source: key };
        }
    }

    // Fallback: earliest date in a dates array if present
    if (Array.isArray(job.dates) && job.dates.length) {
        const validDates = job.dates
            .map((v) => new Date(v))
            .filter((d) => !Number.isNaN(d.getTime()))
            .sort((a, b) => a.getTime() - b.getTime());
            
        if (validDates.length) {
            return { startDate: validDates[0].toISOString(), source: "dates[0]" };
        }
    }

    return { startDate: "", source: null };
};
// ------------------------------------------------------------

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log("📥 Incoming Event:", JSON.stringify(event, null, 2));

    // --- CORS preflight ---
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        console.log("✅ User authenticated. userSub:", userSub);

        // 2. Extract clinicId from proxy path: e.g. "jobs/clinicpermanent/{clinicId}"
        // NOTE: This assumes the route structure matches the index positions
        const pathParts = event.pathParameters?.proxy?.split('/') || [];
        const clinicId = pathParts[2];
        console.log("🔍 Extracted clinicId:", clinicId);

        if (!clinicId) {
            console.warn("⚠️ clinicId missing in path");
            return json(400, { error: "clinicId is required in path" });
        }

        // 3. Query using ClinicIdIndex (GSI)
        const queryCommand = new QueryCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            IndexName: "ClinicIdIndex",
            KeyConditionExpression: "clinicId = :clinicId",
            ExpressionAttributeValues: {
                ":clinicId": { S: clinicId }
            }
        });

        console.log("📤 Sending query to DynamoDB (ClinicIdIndex)...");
        const result: QueryCommandOutput = await dynamodb.send(queryCommand);
        console.log("📦 Raw query result count:", result?.Count || 0);

        // 4. Unmarshall and Filter
        // Convert DynamoDB AttributeValues ({ S: "val" }) to plain JS objects
        const allJobs: UnmarshalledJobItem[] = (result.Items || []).map((item) => unmarshall(item));
        
        // Accept both snake_case and camelCase for job type
        const permanentJobs = allJobs.filter(
            (job) => job.job_type === "permanent" || job.jobType === "permanent"
        );
        console.log(`🎯 Filtered ${permanentJobs.length} permanent job(s)`);

        // 5. Format and Clean Data
        const formattedJobs: FormattedJobItem[] = permanentJobs.map((job, idx) => {
            const { startDate, source } = getPermanentStartDate(job);
            console.log(`🗓️  Job[${idx}] startDate ->`, { value: startDate, source });

            // Prefer snake_case -> camelCase fallbacks everywhere
            const salaryMinRaw = job.salary_min ?? job.salaryMin;
            const salaryMaxRaw = job.salary_max ?? job.salaryMax;
            
            // Helper to safely parse float, defaulting to 0
            const parseSalary = (val: any): number => {
                if (typeof val === "number") return val;
                const num = parseFloat(val || 0);
                return Number.isNaN(num) ? 0 : num;
            };

            const formatted: FormattedJobItem = {
                jobId: job.jobId || "",
                jobType: job.job_type || job.jobType || "permanent",
                professionalRole: job.professional_role || job.professionalRole || "",
                shiftSpeciality: job.shift_speciality || job.shiftSpeciality || "",
                employmentType: job.employment_type || job.employmentType || "",
                
                salaryMin: parseSalary(salaryMinRaw),
                salaryMax: parseSalary(salaryMaxRaw),
                
                benefits: job.benefits || {},
                status: job.status || "active",
                
                addressLine1: job.addressLine1 || job.address_line1 || "",
                addressLine2: job.addressLine2 || job.address_line2 || "",
                addressLine3: job.addressLine3 || job.address_line3 || "",
                
                fullAddress: `${job.addressLine1 || job.address_line1 || ""} ${job.addressLine2 || job.address_line2 || ""} ${job.addressLine3 || job.address_line3 || ""}`.trim(),
                
                city: job.city || "",
                state: job.state || "",
                pincode: job.pincode || job.zipCode || "",
                
                bookingOutPeriod: job.bookingOutPeriod || job.booking_out_period || "immediate",
                clinicSoftware: job.clinicSoftware || job.clinic_software || "Unknown",
                
                // Coalesce boolean/undefined, defaulting to false
                freeParkingAvailable: (job.freeParkingAvailable ?? job.free_parking_available) || false,
                
                parkingType: job.parkingType || job.parking_type || "On-site",
                practiceType: job.practiceType || job.practice_type || "General Dentistry",
                primaryPracticeArea: job.primaryPracticeArea || job.primary_practice_area || "General Dentistry",
                
                startDate, // ISO if parsable, else original string or ""
                createdAt: job.createdAt || "",
                updatedAt: job.updatedAt || ""
            };

            console.log(`🧩 Formatted job [${idx + 1}]:`, formatted);
            return formatted;
        });

        console.log("✅ All permanent jobs formatted successfully");

        // 6. Success Response
        return json(200, {
            message: `Retrieved ${formattedJobs.length} permanent job(s) for clinicId: ${clinicId}`,
            jobs: formattedJobs
        });

    } catch (error: any) {
        console.error("❌ Error during Lambda execution:", error);

        // ✅ Check for Auth errors and return 401
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
            error: "Failed to retrieve permanent jobs",
            details: error.message
        });
    }
};