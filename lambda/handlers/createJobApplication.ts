import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import {
    DynamoDBClient,
    QueryCommand,
    PutItemCommand,
    GetItemCommand,
    AttributeValue,
    GetItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { v4 as uuidv4 } from "uuid";
// Assuming validateToken is a utility function in a local file
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

// Simplified type for the expected DynamoDB Item structure
interface DynamoDBItem {
    [key: string]: AttributeValue;
}

// Interface for the expected request body data structure
interface ApplicationData {
    jobId: string;
    message?: string;
    proposedRate?: number; // Hourly rate
    availability?: string;
    startDate?: string;
    notes?: string;
}

// --- Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Lambda Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === 'OPTIONS') {
        return { statusCode: 200, headers: CORS_HEADERS, body: '' };
    }

    try {
        console.log("Table name for Job Postings: DentiPal-JobPostings");
        console.log("Table name for Job Applications: DentiPal-JobApplications");
        console.log("Table name for Clinic Profiles: DentiPal-ClinicProfiles");
        console.log("Table name for Job Negotiations: DentiPal-JobNegotiations");

        // 1. Authorization
        // validateToken must return the user's sub (string)
        const professionalUserSub: string = await validateToken(event as any);

        const applicationData: ApplicationData = JSON.parse(event.body || '{}');
        console.log("Request body:", applicationData);

        if (!applicationData.jobId) {
            console.warn("[VALIDATION] Missing required field: jobId");
            return json(400, { error: "Required field: jobId" });
        }

        const jobId = applicationData.jobId;

        // 2. ✅ Fetch job posting using jobId-index GSI
        const jobQuery = new QueryCommand({
            TableName: "DentiPal-JobPostings",
            IndexName: "jobId-index",
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId }
            }
        });

        const jobQueryResult = await dynamodb.send(jobQuery);
        if (!jobQueryResult.Items || jobQueryResult.Items.length === 0) {
            console.warn(`[VALIDATION] Job posting not found for jobId: ${jobId}`);
            return json(404, { error: "Job posting not found" });
        }

        const jobItem = jobQueryResult.Items[0];
        const clinicId = jobItem.clinicId?.S;
        const jobStatus = jobItem.status?.S || 'active';

        if (!clinicId) {
            console.error(`[DATA_ERROR] Job posting ${jobId} is missing clinicId.`);
            return json(400, { error: "Clinic ID not found in job posting" });
        }

        if (jobStatus !== "active") {
            console.warn(`[VALIDATION] Job status is '${jobStatus}'. Cannot apply.`);
            return json(400, { error: `Cannot apply to ${jobStatus} job posting` });
        }

        // 3. ✅ Check if application already exists (PK: jobId, SK: professionalUserSub assumed)
        // Note: DynamoDB Query on the primary key (PK and SK) is implicitly supported
        const existingApplicationCommand = new QueryCommand({
            TableName: "DentiPal-JobApplications",
            // Assuming PK is jobId and SK is professionalUserSub for the main table index
            KeyConditionExpression: "jobId = :jobId AND professionalUserSub = :professionalUserSub",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":professionalUserSub": { S: professionalUserSub }
            }
        });

        const existingApplication = await dynamodb.send(existingApplicationCommand);
        if (existingApplication.Items && existingApplication.Items.length > 0) {
            console.warn(`[CONFLICT] User ${professionalUserSub} already applied to job ${jobId}.`);
            return json(409, { error: "You have already applied to this job" });
        }

        // 4. ✅ Prepare application item
        const applicationId = uuidv4();
        const timestamp = new Date().toISOString();
        const hasProposedRate = applicationData.proposedRate !== undefined && applicationData.proposedRate !== null;

        const applicationItem: DynamoDBItem = {
            jobId: { S: jobId },
            professionalUserSub: { S: professionalUserSub },
            applicationId: { S: applicationId },
            clinicId: { S: clinicId },
            // Status is 'negotiating' if a rate is proposed, otherwise 'pending'
            applicationStatus: { S: hasProposedRate ? "negotiating" : "pending" },
            appliedAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };

        if (applicationData.message) {
            applicationItem.applicationMessage = { S: applicationData.message };
        }
        if (hasProposedRate) {
            applicationItem.proposedRate = { N: applicationData.proposedRate!.toString() };
        }
        if (applicationData.availability) {
            applicationItem.availability = { S: applicationData.availability };
        }
        if (applicationData.startDate) {
            applicationItem.startDate = { S: applicationData.startDate };
        }
        if (applicationData.notes) {
            applicationItem.notes = { S: applicationData.notes };
        }

        let negotiationId: string | undefined;
        if (hasProposedRate) {
            negotiationId = uuidv4();
            applicationItem.negotiationId = { S: negotiationId };
        }

        console.log("Creating job application:", JSON.stringify(applicationItem));

        // 5. ✅ Insert into JobApplications table
        await dynamodb.send(new PutItemCommand({
            TableName: "DentiPal-JobApplications", // Using hardcoded table name as in original
            Item: applicationItem
        }));

        // 6. ✅ Negotiating Logic - Handle if the response is "negotiating"
        if (hasProposedRate && negotiationId) {
            // Create negotiation item
            const negotiationItem: DynamoDBItem = {
                negotiationId: { S: negotiationId },
                jobId: { S: jobId },
                applicationId: { S: applicationId },
                professionalUserSub: { S: professionalUserSub },
                clinicId: { S: clinicId },
                negotiationStatus: { S: 'pending' },
                // Use the safe proposedRate value
                proposedHourlyRate: { N: applicationData.proposedRate!.toString() },
                createdAt: { S: timestamp },
                updatedAt: { S: timestamp },
                message: { S: applicationData.message || 'Negotiation initiated by professional during application' }
            };

            // Save negotiation item to JobNegotiations table
            await dynamodb.send(new PutItemCommand({
                TableName: "DentiPal-JobNegotiations", // Using hardcoded table name as in original
                Item: negotiationItem
            }));

            console.log("Job negotiation created:", JSON.stringify(negotiationItem));
        }

        // 7. ✅ Fetch clinic info (Optional/Non-fatal)
        let clinicInfo: any = null;
        try {
            const clinicCommand = new GetItemCommand({
                TableName: "DentiPal-ClinicProfiles", // Using hardcoded table name as in original
                Key: {
                    clinicId: { S: clinicId }
                }
            });

            const clinicResponse = await dynamodb.send(clinicCommand);
            const clinic = clinicResponse.Item;

            if (clinic) {
                clinicInfo = {
                    name: clinic.clinic_name?.S || "Unknown Clinic",
                    city: clinic.city?.S || "",
                    state: clinic.state?.S || "",
                    practiceType: clinic.practice_type?.S || "",
                    primaryPracticeArea: clinic.primary_practice_area?.S || "",
                    contactName: `${clinic.primary_contact_first_name?.S || ""} ${clinic.primary_contact_last_name?.S || ""}`.trim()
                };
            }
        } catch (err) {
            console.warn("Failed to fetch clinic info (non-fatal):", (err as Error).message);
        }

        // 8. ✅ Prepare job info from the fetched jobItem
        const jobInfo = {
            title: jobItem.job_title?.S || `${jobItem.professional_role?.S || "Professional"} Position`,
            type: jobItem.job_type?.S || "unknown",
            role: jobItem.professional_role?.S || "",
            hourlyRate: jobItem.hourly_rate?.N ? parseFloat(jobItem.hourly_rate.N) : undefined,
            date: jobItem.date?.S,
            dates: jobItem.dates?.SS
        };

        // 9. ✅ Final response
        return json(201, {
            message: "Job application submitted successfully",
            applicationId,
            jobId,
            status: hasProposedRate ? "negotiating" : "pending",
            appliedAt: timestamp,
            job: jobInfo,
            clinic: clinicInfo
        });

    } catch (error) {
        const err = error as Error;
        console.error("Error creating job application:", err);
        return json(500, {
            error: "Failed to submit job application. Please try again.",
            details: err.message
        });
    }
};