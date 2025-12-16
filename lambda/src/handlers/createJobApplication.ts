import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings"; 
const APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-ClinicProfiles";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Helpers ---
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- 3. Types ---
interface ApplyJobBody {
    jobId?: string; // Can be in body or path
    message?: string;
    proposedRate?: number;
    availability?: string;
    startDate?: string;
    notes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "POST";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 2. Authentication (Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        console.log("User authenticated:", userSub);

        // 3. Parse Body
        if (!event.body) {
            return json(400, { error: "Request body is required" });
        }
        
        let applicationData: ApplyJobBody;
        try {
            applicationData = JSON.parse(event.body);
        } catch {
            return json(400, { error: "Invalid JSON in request body" });
        }

        // 4. Determine JobId (Path param takes precedence, then body)
        let jobId = event.pathParameters?.jobId;

        if (!jobId) {
            const fullPath = event.pathParameters?.proxy || event.path || ''; 
            const pathParts = fullPath.split('/').filter(Boolean);
            if (pathParts.length >= 2) {
                 jobId = pathParts[1];
            } else if (pathParts.length === 1 && pathParts[0] !== 'applications') {
                 jobId = pathParts[0];
            }
        }
        
        // Fallback to body
        if (!jobId && applicationData.jobId) {
            jobId = applicationData.jobId;
        }

        if (!jobId) {
            return json(400, { error: "jobId is required (in path or body)" });
        }

        console.log("Job ID extracted:", jobId);

        // 5. Check if Job Exists (using GSI on jobId)
        const jobQuery = await ddbDoc.send(new QueryCommand({
            TableName: JOB_POSTINGS_TABLE,
            IndexName: "jobId-index-1", // Ensure this index exists in the table schema
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
                ":jobId": jobId,
            },
            Limit: 1,
        }));

        if (!jobQuery.Items || jobQuery.Items.length === 0) {
            return json(404, { error: "Job posting not found" });
        }

        const jobItem = jobQuery.Items[0];
        const clinicIdFromJob = jobItem.clinicId; // Ensure `clinicId` is part of the schema

        if (!clinicIdFromJob) {
            return json(400, { error: "Clinic ID not found in job posting configuration." });
        }

        const jobStatus = jobItem.status || "active";
        if (jobStatus !== "active") {
            return json(409, {
                error: "Conflict",
                message: "Cannot apply to this job",
                details: { currentStatus: jobStatus, reason: "Job is not accepting applications" },
            });
        }

        // 6. Check for Duplicate Application
        const existingAppsResponse = await ddbDoc.send(new QueryCommand({
            TableName: APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId AND professionalUserSub = :userSub",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":userSub": userSub
            }
        }));

        if (existingAppsResponse.Items && existingAppsResponse.Items.length > 0) {
            return json(409, { 
                error: "Conflict", 
                message: "Duplicate application", 
                details: { reason: "You have already applied to this job", jobId }
            });
        }

        // 7. Prepare Application Data
        const applicationId = uuidv4();
        const timestamp = new Date().toISOString();
        const hasProposedRate = applicationData.proposedRate !== undefined && applicationData.proposedRate !== null;

        const applicationItem: Record<string, any> = {
            jobId: jobId,               // Partition Key
            professionalUserSub: userSub, // Sort Key
            applicationId: applicationId,
            clinicId: clinicIdFromJob,
            // Status logic: 'negotiating' if rate proposed, else 'pending'
            applicationStatus: hasProposedRate ? "negotiating" : "pending",
            appliedAt: timestamp,
            updatedAt: timestamp,
            
            // Optional Fields
            applicationMessage: applicationData.message || null,
            availability: applicationData.availability || null,
            startDate: applicationData.startDate || null,
            notes: applicationData.notes || null,
            proposedRate: hasProposedRate ? Number(applicationData.proposedRate) : null,
            negotiationId: null
        };

        let negotiationId: string | undefined;
        
        // 8. Handle Negotiation Logic
        if (hasProposedRate) {
            negotiationId = uuidv4();
            applicationItem.negotiationId = negotiationId;

            const negotiationItem = {
                negotiationId: negotiationId,
                jobId: jobId,
                applicationId: applicationId,
                professionalUserSub: userSub,
                clinicId: clinicIdFromJob,
                negotiationStatus: 'pending',
                proposedHourlyRate: Number(applicationData.proposedRate),
                createdAt: timestamp,
                updatedAt: timestamp,
                message: applicationData.message || 'Negotiation initiated by professional during application'
            };

            // Save Negotiation
            await ddbDoc.send(new PutCommand({
                TableName: JOB_NEGOTIATIONS_TABLE,
                Item: negotiationItem
            }));
            console.log("Job negotiation created");
        }

        // 9. Save Application
        await ddbDoc.send(new PutCommand({
            TableName: APPLICATIONS_TABLE,
            Item: applicationItem
        }));

        console.log("Job application saved successfully.");

        // 10. Fetch Clinic Info (Non-fatal)
        let clinicInfo: any = null;
        try {
            // Clinic Profiles usually keyed by clinicId (and sometimes userSub). 
            // Assuming PK: clinicId based on your provided snippet.
            // If your table uses composite key, you might need query or specific userSub logic here.
            const clinicRes = await ddbDoc.send(new GetCommand({
                TableName: CLINIC_PROFILES_TABLE,
                Key: { clinicId: clinicIdFromJob } // Note: Add userSub if it's part of PK in your schema
            }));
            
            const clinic = clinicRes.Item;
            if (clinic) {
                clinicInfo = {
                    name: clinic.clinic_name || "Unknown Clinic",
                    city: clinic.city || "",
                    state: clinic.state || "",
                    practiceType: clinic.practice_type || "",
                    primaryPracticeArea: clinic.primary_practice_area || "",
                    contactName: `${clinic.primary_contact_first_name || ""} ${clinic.primary_contact_last_name || ""}`.trim()
                };
            }
        } catch (err) {
            console.warn("Failed to fetch clinic info (non-fatal):", (err as Error).message);
        }

        // 11. Construct Response
        const jobInfo = {
            title: jobItem.job_title || `${jobItem.professional_role || 'Professional'} Position`,
            type: jobItem.job_type || 'unknown',
            role: jobItem.professional_role || '',
            hourlyRate: jobItem.hourly_rate ? Number(jobItem.hourly_rate) : undefined,
            date: jobItem.date,
            dates: jobItem.dates
        };

        return json(201, {
            status: "success",
            statusCode: 201,
            message: "Job application submitted successfully",
            data: {
                applicationId,
                jobId,
                applicationStatus: hasProposedRate ? "negotiating" : "pending",
                appliedAt: timestamp,
                job: jobInfo,
                clinic: clinicInfo
            },
            timestamp: timestamp
        });

    } catch (err) {
        const error = err as Error;
        console.error("Error creating job application:", error);
        return json(500, { 
            error: "Internal Server Error", 
            message: "Failed to submit job application",
            details: error.message 
        });
    }
};