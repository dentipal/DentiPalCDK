import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandInput,
    PutItemCommand,
    PutItemCommandInput,
    QueryCommand,
    QueryCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuid } from "uuid"; // Import v4 for UUID generation
import { extractUserFromBearerToken } from "./utils"; // Import extractUserFromBearerToken function (assuming it's in utils.ts)

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// Define the expected structure for the request body
interface ApplicationRequestBody {
    message?: string;
    proposedRate?: number;
    availability?: string;
    startDate?: string;
    notes?: string;
}

// Define the structure for the job info to be returned
interface JobInfo {
    title: string;
    type: string;
    role: string;
    hourlyRate: number | undefined;
    date?: string;
    dates?: string[];
}

// Define the structure for the clinic info to be returned
interface ClinicInfo {
    name: string;
    city: string;
    state: string;
    practiceType: string;
    primaryPracticeArea: string;
    contactName: string;
}

// Define the Lambda handler function
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Log the received event for debugging
        console.log("Received event:", JSON.stringify(event));

        // Step 1: Extract the jobId from the proxy path
        const fullPath = event.pathParameters?.proxy || ''; // e.g., 'applications/3671fee1-12ee-413c-bade-3c2e71223756'
        // pathParts[0] is 'applications', pathParts[1] is the jobId
        const pathParts = fullPath.split('/').filter(Boolean);
        const jobId = pathParts[1]; 

        if (!jobId) {
            console.error("jobId is missing in the path parameters");
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job ID is required",
                details: { location: "path parameters" },
                timestamp: new Date().toISOString()
            });
        }

        console.log("Job ID extracted from path:", jobId);

        // Step 2: Extract and validate user token and parse application data
        // Extract access token from Authorization header
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, {
                error: authError.message || "Invalid access token"
            });
        }
        const applicationData: ApplicationRequestBody = JSON.parse(event.body || "{}");

        console.log("Parsed application data:", applicationData);

        // Simple check for body presence
        if (Object.keys(applicationData).length === 0 && !event.body) {
             return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Application data is missing",
                details: { body: "empty" },
                timestamp: new Date().toISOString()
            });
        }

        // Step 3: Fetch the job posting to get clinicId and status
        const jobExistsInput: GetItemCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            }
        };
        const jobExistsCommand = new GetItemCommand(jobExistsInput);
        const jobExists = await dynamodb.send(jobExistsCommand);

        if (!jobExists.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Job posting not found",
                details: { jobId },
                timestamp: new Date().toISOString()
            });
        }

        // Extract clinicId from the job posting
        const clinicIdFromJob: string | undefined = jobExists.Item.clinicUserSub?.S;
        // In the original JS, clinicIdFromJob is sometimes referred to as 'clinicId' and sometimes as 'clinicUserSub' 
        // in the Key for CLINIC_PROFILES_TABLE. We assume clinicUserSub is the correct identifier for the clinic profile.
        if (!clinicIdFromJob) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job posting is incomplete",
                details: { missingField: "clinicUserSub" },
                timestamp: new Date().toISOString()
            });
        }

        console.log("Clinic ID from job:", clinicIdFromJob);

        // Check if the job posting is active
        const jobStatus: string = jobExists.Item.status?.S || 'active';
        if (jobStatus !== 'active') {
            return json(409, {
                error: "Conflict",
                statusCode: 409,
                message: "Cannot apply to this job",
                details: { currentStatus: jobStatus, reason: "Job is not accepting applications" },
                timestamp: new Date().toISOString()
            });
        }

        // Step 4: Check if user has already applied to this job (no restrictions, multiple applications allowed)
        console.log("Checking if the user has already applied...");
        
        // This query uses jobId as the Partition Key and filters on professionalUserSub.
        // If the table uses a composite key (jobId, applicationId), this Query works.
        const existingApplicationInput: QueryCommandInput = {
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "professionalUserSub = :userSub",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":userSub": { S: userSub }
            } as Record<string, AttributeValue>
        };

        const existingApplicationCommand = new QueryCommand(existingApplicationInput);
        const existingApplication = await dynamodb.send(existingApplicationCommand);
        
        if (existingApplication.Items && existingApplication.Items.length > 0) {
            console.log("User has already applied to this job.");
            return json(409, {
                error: "Conflict",
                statusCode: 409,
                message: "Duplicate application",
                details: { reason: "You have already applied to this job", jobId },
                timestamp: new Date().toISOString()
            });
        }

        // Step 5: Create new application record
        const applicationId: string = uuid();
        const timestamp: string = new Date().toISOString();

        // Build DynamoDB item with explicit AttributeValue structure
        const applicationItem: Record<string, AttributeValue> = {
            jobId: { S: jobId }, // Partition Key
            applicationId: { S: applicationId }, // Sort Key
            professionalUserSub: { S: userSub },
            clinicUserSub: { S: clinicIdFromJob }, // Use clinicUserSub as the attribute name
            applicationStatus: { S: 'pending' },
            appliedAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };

        // Add optional fields
        if (applicationData.message) {
            applicationItem.applicationMessage = { S: applicationData.message };
        }
        if (applicationData.proposedRate !== undefined) {
            applicationItem.proposedRate = { N: applicationData.proposedRate.toString() };
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

        // Save application in DynamoDB
        console.log("Saving job application...");
        const putItemInput: PutItemCommandInput = {
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            Item: applicationItem
        };
        await dynamodb.send(new PutItemCommand(putItemInput));

        // Step 6: Fetch clinic and job details for the response payload

        // Fetch clinic details
        let clinicInfo: ClinicInfo | null = null;
        try {
            console.log("Fetching clinic details...");
            const clinicCommandInput: GetItemCommandInput = {
                TableName: process.env.CLINIC_PROFILES_TABLE,
                Key: {
                    userSub: { S: clinicIdFromJob } // Assumes the clinic profile PK is 'userSub'
                }
            };

            const clinicCommand = new GetItemCommand(clinicCommandInput);
            const clinicResponse = await dynamodb.send(clinicCommand);
            
            if (clinicResponse.Item) {
                const clinic = clinicResponse.Item;
                clinicInfo = {
                    name: clinic.clinic_name?.S || 'Unknown Clinic',
                    city: clinic.city?.S || '',
                    state: clinic.state?.S || '',
                    practiceType: clinic.practice_type?.S || '',
                    primaryPracticeArea: clinic.primary_practice_area?.S || '',
                    contactName: `${clinic.primary_contact_first_name?.S || ''} ${clinic.primary_contact_last_name?.S || ''}`.trim() || 'Contact',
                };
            }
        }
        catch (clinicError) {
            console.warn("Failed to fetch clinic details:", (clinicError as Error).message);
        }

        // Fetch job details (using the already fetched jobExists.Item)
        let jobInfo: JobInfo | null = null;
        const jobDetails = jobExists.Item;
        if (jobDetails) {
            jobInfo = {
                title: jobDetails.job_title?.S || `${jobDetails.professional_role?.S || 'Professional'} Position`,
                type: jobDetails.job_type?.S || 'unknown',
                role: jobDetails.professional_role?.S || '',
                hourlyRate: jobDetails.hourly_rate?.N ? parseFloat(jobDetails.hourly_rate.N) : undefined,
                date: jobDetails.date?.S,
                dates: jobDetails.dates?.SS,
            };
        }


        // Step 7: Return response with application details
        console.log("Job application submitted successfully.");
        return json(201, {
            status: "success",
            statusCode: 201,
            message: "Job application submitted successfully",
            data: {
                applicationId,
                jobId: jobId,
                applicationStatus: "pending",
                appliedAt: timestamp,
                job: jobInfo,
                clinic: clinicInfo
            },
            timestamp: new Date().toISOString()
        });
    }
    catch (error) {
        const err = error as Error;
        console.error("Error creating job application:", err);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to submit job application",
            details: { reason: err.message },
            timestamp: new Date().toISOString()
        });
    }
};
exports.handler = handler;