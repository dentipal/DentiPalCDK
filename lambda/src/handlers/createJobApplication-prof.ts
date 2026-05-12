import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, QueryCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";
import { extractAuthFromEvent, AuthContext } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { fireAndForgetJobApplicationIncrement } from "./jobPostingCounters";

// --- 1. Configuration ---
const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const APPLICATIONS_TABLE = process.env.APPLICATIONS_TABLE || "DentiPal-JobApplications";

const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// --- 2. Types ---

/** Shape the chatbot tool (and the existing form) sends. */
export interface CreateJobApplicationInput {
    message: string;
    proposedRate: number;
    availability: string;
    startDate?: string;
    notes?: string;
    [key: string]: any;
}

export interface CreateJobApplicationResult {
    status: number;
    body: any;
}

// --- 3. Core logic (callable from handler OR chatbot toolExecutor in-process) ---

export async function runCreateJobApplication(
    jobId: string,
    input: CreateJobApplicationInput,
    auth: AuthContext
): Promise<CreateJobApplicationResult> {
    if (!jobId) {
        return { status: 400, body: { error: "jobId is required" } };
    }

    if (!input.message || !input.proposedRate || !input.availability) {
        return {
            status: 400,
            body: { error: "Missing required fields (message, proposedRate, availability)." },
        };
    }

    // 1. Check if Job Exists
    const jobResult = await ddbDoc.send(new GetCommand({
        TableName: JOB_POSTINGS_TABLE,
        Key: { jobId },
    }));

    if (!jobResult.Item) {
        return { status: 404, body: { error: "Job posting not found" } };
    }

    const jobItem = jobResult.Item;
    const clinicIdFromJob = jobItem.clinicUserSub || jobItem.clinicId;
    if (!clinicIdFromJob) {
        return { status: 400, body: { error: "Clinic ID not found in job posting configuration." } };
    }

    const jobStatus = jobItem.status || 'active';
    if (jobStatus !== 'active') {
        return { status: 400, body: { error: `Cannot apply to ${jobStatus} job posting` } };
    }

    // 2. Duplicate check (rejected applications can be re-applied to)
    const existingAppsResponse = await ddbDoc.send(new QueryCommand({
        TableName: APPLICATIONS_TABLE,
        KeyConditionExpression: "jobId = :jobId",
        FilterExpression: "professionalUserSub = :userSub",
        ExpressionAttributeValues: {
            ":jobId": jobId,
            ":userSub": auth.userSub,
        },
    }));

    if (existingAppsResponse.Items && existingAppsResponse.Items.length > 0) {
        return { status: 409, body: { error: "You have already applied to this job" } };
    }

    // 3. Create Application
    const applicationId = uuidv4();
    const timestamp = new Date().toISOString();

    const applicationItem = {
        jobId,
        professionalUserSub: auth.userSub,
        applicationId,
        clinicId: clinicIdFromJob,
        applicationStatus: 'pending',
        appliedAt: timestamp,
        updatedAt: timestamp,
        applicationMessage: input.message,
        proposedRate: Number(input.proposedRate),
        availability: input.availability,
        startDate: input.startDate || null,
        notes: input.notes || null,
    };

    await ddbDoc.send(new PutCommand({
        TableName: APPLICATIONS_TABLE,
        Item: applicationItem,
    }));

    fireAndForgetJobApplicationIncrement(jobItem);

    const jobInfo = {
        title: jobItem.job_title || `${jobItem.professional_role || 'Professional'} Position`,
        type: jobItem.job_type || 'unknown',
        role: jobItem.professional_role || '',
        rate: jobItem.rate
            ?? (jobItem.pay_type === "per_transaction"
                ? jobItem.rate_per_transaction
                : jobItem.pay_type === "percentage_of_revenue"
                    ? jobItem.revenue_percentage
                    : jobItem.hourly_rate)
            ?? 0,
        payType: jobItem.pay_type || "per_hour",
        date: jobItem.date,
        dates: jobItem.dates,
    };

    return {
        status: 201,
        body: {
            message: "Job application submitted successfully",
            applicationId,
            jobId,
            status: "pending",
            appliedAt: timestamp,
            job: jobInfo,
        },
    };
}

// --- 4. Helpers ---
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// --- 5. Thin API Gateway adapter ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // Extract jobId (path param or last path segment)
        let jobId = event.pathParameters?.jobId;
        if (!jobId) {
            const fullPath = event.pathParameters?.proxy || event.path || '';
            const pathParts = fullPath.split('/').filter(Boolean);
            if (pathParts.length >= 2) {
                jobId = pathParts[1];
            } else if (pathParts.length === 1) {
                jobId = pathParts[0];
            }
        }

        if (!jobId) {
            return json(event, 400, { error: "jobId is required in the path parameters" });
        }

        // Auth
        let auth: AuthContext;
        try {
            auth = extractAuthFromEvent(event);
        } catch (authError: any) {
            return json(event, 401, { error: authError.message || "Invalid access token" });
        }

        // Body
        if (!event.body) {
            return json(event, 400, { error: "Request body is required" });
        }
        let input: CreateJobApplicationInput;
        try {
            input = JSON.parse(event.body);
        } catch {
            return json(event, 400, { error: "Invalid JSON in request body" });
        }

        const { status, body } = await runCreateJobApplication(jobId, input, auth);
        return json(event, status, body);

    } catch (err) {
        const error = err as Error;
        console.error("Error creating job application:", error);
        return json(event, 500, {
            error: "Failed to submit job application.",
            details: error.message,
        });
    }
};
