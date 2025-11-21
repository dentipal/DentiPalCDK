import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. Configuration ---
const REGION = process.env.REGION || "us-east-1";
// Using separate tables for Postings and Applications is best practice
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings"; 
const APPLICATIONS_TABLE = process.env.APPLICATIONS_TABLE || "DentiPal-JobApplications";

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
    message: string;
    proposedRate: number;
    availability: string;
    startDate?: string;
    notes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    // 1. Handle CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        console.log("Received event path:", event.path);

        // 2. Extract jobId
        // Robust extraction handles /applications/{jobId} (REST) or proxy integration
        let jobId = event.pathParameters?.jobId;

        if (!jobId) {
            // Fallback logic matching original code: parsing path parts
            const fullPath = event.pathParameters?.proxy || event.path || ''; 
            const pathParts = fullPath.split('/').filter(Boolean);
            
            // Assuming structure like /applications/{jobId} -> index 1
            if (pathParts.length >= 2) {
                 jobId = pathParts[1];
            } else if (pathParts.length === 1) {
                 // Fallback for structure /{jobId}
                 jobId = pathParts[0];
            }
        }

        if (!jobId) {
            return json(400, { error: "jobId is required in the path parameters" });
        }

        console.log("Job ID extracted:", jobId);

        // 3. Authentication (Switched to Access Token)
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        console.log("User authenticated:", userSub);

        // 4. Parse & Validate Body
        if (!event.body) {
            return json(400, { error: "Request body is required" });
        }
        
        let applicationData: ApplyJobBody;
        try {
            applicationData = JSON.parse(event.body);
        } catch {
            return json(400, { error: "Invalid JSON in request body" });
        }

        if (!applicationData.message || !applicationData.proposedRate || !applicationData.availability) {
            return json(400, { error: "Missing required fields (message, proposedRate, availability)." });
        }

        // 5. Check if Job Exists
        // Note: We query the JOB_POSTINGS_TABLE, not the applications table, to verify the job.
        const jobResult = await ddbDoc.send(new GetCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: { jobId: jobId }
        }));
        
        if (!jobResult.Item) {
            return json(404, { error: "Job posting not found" });
        }

        const jobItem = jobResult.Item;
        // Support both field naming conventions commonly used
        const clinicIdFromJob = jobItem.clinicUserSub || jobItem.clinicId; 

        if (!clinicIdFromJob) {
            return json(400, { error: "Clinic ID not found in job posting configuration." });
        }

        const jobStatus = jobItem.status || 'active';
        if (jobStatus !== 'active') {
            return json(400, { error: `Cannot apply to ${jobStatus} job posting` });
        }

        // 6. Check for Duplicate Application
        // Query the Applications table to see if this user already applied to this job
        const existingAppsResponse = await ddbDoc.send(new QueryCommand({
            TableName: APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "professionalUserSub = :userSub",
            ExpressionAttributeValues: {
                ":jobId": jobId,
                ":userSub": userSub
            }
        }));

        if (existingAppsResponse.Items && existingAppsResponse.Items.length > 0) {
            return json(409, { error: "You have already applied to this job" });
        }

        // 7. Create Application
        const applicationId = uuidv4();
        const timestamp = new Date().toISOString();

        const applicationItem = {
            jobId: jobId,               // Partition Key
            professionalUserSub: userSub, // Sort Key (allows querying all apps for a job)
            applicationId: applicationId,
            clinicId: clinicIdFromJob,
            applicationStatus: 'pending',
            appliedAt: timestamp,
            updatedAt: timestamp,
            // Application Details
            applicationMessage: applicationData.message,
            proposedRate: Number(applicationData.proposedRate),
            availability: applicationData.availability,
            startDate: applicationData.startDate || null,
            notes: applicationData.notes || null
        };

        await ddbDoc.send(new PutCommand({
            TableName: APPLICATIONS_TABLE,
            Item: applicationItem
        }));

        console.log("Job application saved successfully.");

        // 8. Construct Response
        const jobInfo = {
            title: jobItem.job_title || `${jobItem.professional_role || 'Professional'} Position`,
            type: jobItem.job_type || 'unknown',
            role: jobItem.professional_role || '',
            hourlyRate: jobItem.hourly_rate ? Number(jobItem.hourly_rate) : undefined,
            date: jobItem.date,
            dates: jobItem.dates
        };

        return json(201, {
            message: "Job application submitted successfully",
            applicationId,
            jobId,
            status: "pending",
            appliedAt: timestamp,
            job: jobInfo
        });

    } catch (err) {
        const error = err as Error;
        console.error("Error creating job application:", error);
        return json(500, { 
            error: "Failed to submit job application.", 
            details: error.message 
        });
    }
};