import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken, hasClinicAccess, isRoot, UserInfo } from "./utils"; 
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

// --- Type Definitions (Simplified for Permanent Job) ---

interface PermanentJobData {
    clinicIds: string[];
    professional_role: string;
    shift_speciality: string;
    job_title?: string;
    job_description?: string;
    requirements?: string[];
    employment_type: "full_time" | "part_time";
    salary_min: number;
    salary_max: number;
    benefits: string[];
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

// --- Validation Functions (Permanent Only) ---

const validatePermanentJob = (jobData: PermanentJobData): string | null => {
    // ... validation logic (omitted for brevity, assume correct) ...
    
    // Add salary range validation log
    if (jobData.salary_min < 20000 || jobData.salary_min > 500000) {
        console.log(`Validation Failed: Minimum salary ${jobData.salary_min} out of range.`);
        return "Minimum salary must be between $20,000 and $500,000";
    }
    
    return null;
};

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log('🚀 HANDLER STARTED - createPermanentJob.ts (Dedicated)');
    console.log('HTTP Method:', event.httpMethod);
    console.log('Path:', event.path);
    console.log('📋 ALL HEADERS:', JSON.stringify(event.headers, null, 2));
    console.log('🔐 Authorization Header Value:', event.headers?.Authorization || event.headers?.authorization || 'MISSING');
    
    // --- CORS preflight ---
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }
    
    if (method !== "POST") {
        return json(405, { error: "Method Not Allowed", message: "Only POST requests are allowed on this endpoint." });
    }

    let userSub: string;
    let userGroups: string[] = [];
    let jobData: PermanentJobData;

    try {
        console.log('=== STEP 1: AUTHENTICATION ===');
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        console.log('🔐 Auth Header from headers:', authHeader ? 'YES - ' + authHeader.substring(0, 50) + '...' : 'NO');
        console.log('📦 Full event.requestContext:', JSON.stringify((event.requestContext as any), null, 2));
        
        if (!authHeader) {
            console.error('❌ NO AUTHORIZATION HEADER FOUND');
            console.log('Available headers keys:', Object.keys(event.headers || {}));
            throw new Error("Authorization header missing");
        }
        
        // Assume utils.ts logs details here
        const userInfo: UserInfo = extractUserFromBearerToken(authHeader);
        
        userSub = userInfo.sub;
        userGroups = userInfo.groups || [];
        console.log('✅ User authenticated. Sub:', userSub, 'Groups:', userGroups);
        
        console.log('=== STEP 2: AUTHORIZATION ===');
        const normalized = userGroups.map(normalizeGroup);
        const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
        console.log(`User groups normalized: ${normalized.join(', ')}. Is allowed: ${isAllowed}`);

        if (!isAllowed) {
            console.warn(`403 Forbidden: User ${userSub} denied. Groups: [${userGroups.join(', ')}]`);
            return json(403, {
                error: "Forbidden",
                message: "Access denied: only Root, ClinicAdmin, or ClinicManager can create permanent jobs",
                details: { requiredGroups: ALLOWED_GROUPS_DISPLAY, userGroups }
            });
        }

        // 3. Parse Body
        jobData = JSON.parse(event.body || '{}');
        console.log(`Request Body parsed. Clinics to process: ${jobData.clinicIds.length}`);

        // 4. Validation
        console.log('=== STEP 3: VALIDATION ===');
        const validationError = validatePermanentJob(jobData);

        if (validationError) {
            console.error(`400 Bad Request: Validation failed: ${validationError}`);
            return json(400, {
                error: "Bad Request",
                message: "Validation failed",
                details: { validationError }
            });
        }
        console.log('Input validation successful.');
        
        // 5. Verify Clinic Access
        console.log('=== STEP 4: CLINIC ACCESS CHECK ===');
        const isRootUser = isRoot(userGroups);
        
        if (!isRootUser) {
            for (const clinicId of jobData.clinicIds) {
                const hasAccess = await hasClinicAccess(userSub, clinicId);
                console.log(`Checking access for Clinic ${clinicId}: ${hasAccess}`);
                if (!hasAccess) {
                    console.warn(`403 Forbidden: Access denied to clinic ${clinicId}`);
                    return json(403, {
                        error: "Forbidden",
                        message: `Access denied to clinic ${clinicId}. You can only create jobs for clinics you manage.`,
                        details: { deniedClinicId: clinicId }
                    });
                }
            }
        }
        console.log('Clinic access verified for all requested clinics.');

        const timestamp = new Date().toISOString();
        const jobIds: string[] = [];
        const createdJobs: any[] = [];
        const failedClinics: { clinicId: string, error: string }[] = [];

        // 6. Process Each Clinic 
        console.log(`=== STEP 5: CREATING ${jobData.clinicIds.length} JOBS ===`);
        const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
            try {
                const jobId = uuidv4();
                console.log(`[Clinic ${clinicId}] Starting job creation with ID: ${jobId}`);

                const clinicResponse = await ddbDoc.send(new GetCommand({ TableName: CLINICS_TABLE, Key: { clinicId: clinicId } }));
                const clinic = clinicResponse.Item;
                if (!clinic) throw new Error(`Clinic not found in DB`);
                console.log(`[Clinic ${clinicId}] Clinic details fetched.`);
                
                // Fetch profile logic
                // ...
                console.log(`[Clinic ${clinicId}] Profile data aggregated.`);

                // Build item logic
                const item: Record<string, any> = {
                    // ... item creation ...
                    jobId: jobId,
                    job_type: "permanent", 
                    clinicId: clinicId,
                    clinicUserSub: userSub,
                    // ... other fields
                };

                await ddbDoc.send(new PutCommand({ TableName: JOB_POSTINGS_TABLE, Item: item }));

                jobIds.push(jobId);
                createdJobs.push({ clinicId, jobId });
                console.log(`[Clinic ${clinicId}] Job successfully written to DynamoDB.`);
                
            } catch (error: any) {
                console.error(`[Clinic ${clinicId}] Failed to create job:`, error.message);
                failedClinics.push({ clinicId, error: error.message || 'Unknown error' });
            }
        });

        await Promise.all(postJobsPromises);
        console.log('=== STEP 6: RESPONSE GENERATION ===');
        
        // ... Response Handling logic ...
        
        if (jobIds.length === 0) {
            console.error('500 Error: No jobs created.');
            // Return 500
        }

        const statusCode = jobIds.length === jobData.clinicIds.length ? 201 : 207;
        console.log(`Handler finished. Status: ${statusCode}. Successes: ${jobIds.length}, Failures: ${failedClinics.length}`);
        
        return json(statusCode, { /* ... response data ... */ });

    } catch (error: any) {
        console.error("Critical Unhandled Error:", error);
        
        if (error.message?.includes("Authorization header") || error.message?.includes("token")) {
            console.log('Returning 401 Unauthorized.');
            return json(401, { error: "Unauthorized", details: error.message });
        }
        
        console.log('Returning 500 Internal Server Error.');
        return json(500, {
            error: "Internal Server Error",
            message: "Failed to process job posting request",
            details: { reason: error.message }
        });
    }
};