import {
    DynamoDBClient,
    ScanCommand,
    GetItemCommand,
    QueryCommand,
    AttributeValue,
    GetItemCommandOutput,
    QueryCommandOutput,
    ScanCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Changed import to use the new token utility
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ---------- Type Definitions ----------

// Define a type for a raw DynamoDB item (Negotiation)
interface DynamoDBNegotiationItem {
    negotiationId?: AttributeValue;
    applicationId?: AttributeValue;
    jobId?: AttributeValue;
    clinicId?: AttributeValue;
    professionalUserSub?: AttributeValue;
    negotiationStatus?: AttributeValue;
    clinicResponse?: AttributeValue;
    proposedHourlyRate?: AttributeValue; // N
    message?: AttributeValue;
    createdAt?: AttributeValue;
    updatedAt?: AttributeValue;
    // ... other attributes
    [key: string]: AttributeValue | undefined;
}

// Define the enriched response item structure
interface EnrichedNegotiation {
    negotiationId: string;
    applicationId: string;
    jobId: string;
    clinicId: string;
    professionalUserSub: string;
    negotiationStatus: string;
    clinicResponse: string;
    proposedHourlyRate: number | null;
    message: string;
    createdAt: string;
    updatedAt: string;
    clinicInfo?: {
        name: string;
        city: string;
        state: string;
        primaryPracticeArea: string;
        contactName: string;
    };
    jobInfo?: {
        jobTitle: string;
        jobType: string;
        professionalRole: string;
        hourlyRate: number | null;
        hoursPerDay: number | null;
        location: {
            city: string;
            state: string;
            zipCode: string;
        };
        date: string;
        startTime: string;
        endTime: string;
        status: string;
    };
}

// ---------- Small utils ----------

const str = (v: any): string => (typeof v === "string" ? v.trim() : "");
const TABLE_NEGS: string = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";
const TABLE_CLINICS: string = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";
const TABLE_JOBS: string = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings"; // has jobId-index GSI

// ---------- Fetch helpers tailored to your indexes ----------

/**
 * Get latest negotiation for an application (table PK = applicationId, SK = negotiationId or similar)
 * @param applicationId The Partition Key of the negotiation table.
 * @returns The latest negotiation item or null.
 */
async function fetchByApplicationId(applicationId: string): Promise<DynamoDBNegotiationItem | null> {
    try {
        // Mode 1: Query (assumes applicationId is PK)
        const q: QueryCommandOutput = await dynamodb.send(new QueryCommand({
            TableName: TABLE_NEGS,
            KeyConditionExpression: "applicationId = :a",
            ExpressionAttributeValues: { ":a": { S: applicationId } },
            ScanIndexForward: false, // newest first (if SK is timestamp)
            Limit: 1,
        }));
        return q.Items?.[0] as DynamoDBNegotiationItem || null;
    } catch (e) {
        // Mode 2: Fallback scan if table key differs
        const s: ScanCommandOutput = await dynamodb.send(new ScanCommand({
            TableName: TABLE_NEGS,
            FilterExpression: "#app = :a",
            ExpressionAttributeNames: { "#app": "applicationId" },
            ExpressionAttributeValues: { ":a": { S: applicationId } },
            Limit: 1,
        }));
        return s.Items?.[0] as DynamoDBNegotiationItem || null;
    }
}

/**
 * Use GSI **JobIndex** (PK: jobId, SK: createdAt) to fetch the latest
 * negotiation for a given jobId and professional.
 * @param jobId The Partition Key of the GSI.
 * @param professionalUserSub The sub to filter the results by.
 * @returns The latest matching negotiation item or null.
 */
async function fetchByJobAndPro(jobId: string, professionalUserSub: string): Promise<DynamoDBNegotiationItem | null> {
    // Query JobIndex by jobId, newest first; then filter in memory by professionalUserSub
    const q: QueryCommandOutput = await dynamodb.send(new QueryCommand({
        TableName: TABLE_NEGS,
        IndexName: "JobIndex", // <-- from your configuration
        KeyConditionExpression: "jobId = :jid",
        ExpressionAttributeValues: { ":jid": { S: jobId } },
        ScanIndexForward: false, // newest first (assuming createdAt is SK)
        Limit: 50, // pull a page to find the match
    }));

    const items: DynamoDBNegotiationItem[] = q.Items as DynamoDBNegotiationItem[] || [];
    
    // Find the first item whose professionalUserSub matches the target sub
    const match = items.find(it => (it.professionalUserSub?.S || "") === professionalUserSub);
    
    // Pagination logic is skipped as per original code comment, just return the first match in the first page
    return match || null;
}

/**
 * List all negotiations for the authenticated professional (uses Scan for simplicity).
 * @param professionalUserSub The sub to filter the results by.
 * @param statusFilter Optional status filter string.
 * @returns An array of raw negotiation items.
 */
async function fetchAllForProfessional(professionalUserSub: string, statusFilter: string | null): Promise<DynamoDBNegotiationItem[]> {
    const scanCommand: ScanCommandOutput = await dynamodb.send(new ScanCommand({
        TableName: TABLE_NEGS,
        FilterExpression:
            "professionalUserSub = :sub" +
            (statusFilter ? " AND negotiationStatus = :status" : ""),
        ExpressionAttributeValues: {
            ":sub": { S: professionalUserSub },
            ...(statusFilter && { ":status": { S: statusFilter } }),
        },
    }));
    return scanCommand.Items as DynamoDBNegotiationItem[] || [];
}

// ---------- Enrichment ----------

/**
 * Transforms a raw negotiation item and enriches it with clinic and job details.
 * @param neg The raw DynamoDB negotiation item.
 * @returns The enriched negotiation object.
 */
async function enrichWithClinicAndJob(neg: DynamoDBNegotiationItem): Promise<EnrichedNegotiation> {
    const negotiation: Partial<EnrichedNegotiation> & Pick<EnrichedNegotiation, 'negotiationId' | 'applicationId' | 'jobId' | 'clinicId' | 'professionalUserSub' | 'negotiationStatus' | 'clinicResponse' | 'message' | 'createdAt' | 'updatedAt'> = {
        negotiationId: neg.negotiationId?.S || "",
        applicationId: neg.applicationId?.S || "",
        jobId: neg.jobId?.S || "",
        clinicId: neg.clinicId?.S || "",
        professionalUserSub: neg.professionalUserSub?.S || "",
        negotiationStatus: neg.negotiationStatus?.S || "",
        clinicResponse: neg.clinicResponse?.S || "",
        proposedHourlyRate: neg.proposedHourlyRate?.N ? parseFloat(neg.proposedHourlyRate.N) : null,
        message: neg.message?.S || "",
        createdAt: neg.createdAt?.S || "",
        updatedAt: neg.updatedAt?.S || "",
    };

    // --- Clinic info (GetItem by clinicId) ---
    try {
        if (negotiation.clinicId) {
            const clinicResp: GetItemCommandOutput = await dynamodb.send(new GetItemCommand({
                TableName: TABLE_CLINICS,
                Key: { clinicId: { S: negotiation.clinicId } },
            }));
            const c = clinicResp.Item;
            if (c) {
                negotiation.clinicInfo = {
                    name: c.clinic_name?.S || "Unknown Clinic",
                    city: c.city?.S || "",
                    state: c.state?.S || "",
                    primaryPracticeArea: c.primary_practice_area?.S || "",
                    contactName: `${c.primary_contact_first_name?.S || ""} ${c.primary_contact_last_name?.S || ""}`.trim(),
                };
            }
        }
    } catch (err) {
        console.warn(`Failed to fetch clinic info for ${negotiation.clinicId}:`, err);
    }

    // --- Job info (Query by jobId GSI) ---
    try {
        if (negotiation.jobId) {
            const jobResult: QueryCommandOutput = await dynamodb.send(new QueryCommand({
                TableName: TABLE_JOBS,
                IndexName: "jobId-index",
                KeyConditionExpression: "jobId = :jobId",
                ExpressionAttributeValues: { ":jobId": { S: negotiation.jobId } },
                Limit: 1,
            }));
            const job = jobResult.Items?.[0];
            if (job) {
                negotiation.jobInfo = {
                    jobTitle: job.job_title?.S || `${job.professional_role?.S || "Professional"} Position`,
                    jobType: job.job_type?.S || "",
                    professionalRole: job.professional_role?.S || "",
                    hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : null,
                    hoursPerDay: job.hours_per_day?.N ? parseFloat(job.hours_per_day.N) : null,
                    location: {
                        city: job.city?.S || "",
                        state: job.state?.S || "",
                        zipCode: job.pincode?.S || "",
                    },
                    date: job.date?.S || "",
                    startTime: job.start_time?.S || "",
                    endTime: job.end_time?.S || "",
                    status: job.status?.S || "active",
                };
            }
        }
    } catch (err) {
        console.warn(`Failed to fetch job info for ${negotiation.jobId}:`, err);
    }

    return negotiation as EnrichedNegotiation;
}

// ---------- Handler ----------

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Preflight
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        const qs = event.queryStringParameters || {};
        const statusFilter = str(qs.status) || null;

        // New filters supported for clinic/any side:
        const applicationId = str(qs.applicationId);
        const jobId = str(qs.jobId);
        const professionalUserSubParam = str(qs.professionalUserSub);

        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        let professionalUserSub: string | null = null;
        
        // Extract user sub from token. We wrap in try/catch since this logic was partially 
        // optional or used 'try identify caller' pattern in the original code.
        // If strict auth is required, remove the catch block.
        try {
             const userInfo = extractUserFromBearerToken(authHeader);
             professionalUserSub = userInfo.sub;
        } catch (_) {
             // Token might be missing or invalid. Logic below handles missing professionalUserSub.
             professionalUserSub = null;
        }

        // ---- Mode A: by applicationId (single, latest) ----
        if (applicationId) {
            const raw = await fetchByApplicationId(applicationId);
            if (!raw) {
                return {
                    statusCode: 404,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: "No negotiations found for this applicationId" }),
                };
            }
            const item = await enrichWithClinicAndJob(raw);
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({ item }),
            };
        }

        // ---- Mode B: by jobId + professionalUserSub (single, latest) ----
        if (jobId && professionalUserSubParam) {
            const raw = await fetchByJobAndPro(jobId, professionalUserSubParam);
            if (!raw) {
                return {
                    statusCode: 404,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({
                        error: "No negotiation found for the given jobId and professionalUserSub",
                    }),
                };
            }
            const item = await enrichWithClinicAndJob(raw);
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({ item }),
            };
        }

        // ---- Mode C: default list for authenticated professional ----
        if (!professionalUserSub) {
            // If we reached here, we need an authenticated user to fetch their specific negotiations
            return {
                statusCode: 401, // Changed from 400 to 401 for auth missing
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Unauthorized: Missing or invalid access token" }),
            };
        }

        const rawItems = await fetchAllForProfessional(professionalUserSub, statusFilter);
        const negotiations: EnrichedNegotiation[] = [];
        
        // Use Promise.all to concurrently enrich data for faster results
        const enrichedPromises = rawItems.map(it => enrichWithClinicAndJob(it));
        negotiations.push(...(await Promise.all(enrichedPromises)));
        
        // sort by updatedAt desc
        negotiations.sort((a, b) => new Date(b.updatedAt || 0).getTime() - new Date(a.updatedAt || 0).getTime());

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Negotiations retrieved successfully",
                negotiations,
                totalCount: negotiations.length,
                filter: statusFilter || "all",
            }),
        };
    } catch (error: any) {
        console.error("Error fetching negotiations:", error);
        
        // ✅ Check for Auth errors and return 401 (if they bubble up)
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Failed to retrieve negotiations",
                details: error.message,
            }),
        };
    }
};