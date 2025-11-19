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
import { validateToken } from "./utils"; // Import validateToken function (assuming it's in utils.ts)

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

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
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in the path parameters"
                })
            };
        }

        console.log("Job ID extracted from path:", jobId);

        // Step 2: Extract and validate user token and parse application data
        // We cast event to 'any' here because APIGatewayProxyEvent doesn't include the Cognito claims object by default.
        const userSub: string = await validateToken(event as any); 
        const applicationData: ApplicationRequestBody = JSON.parse(event.body || "{}");

        console.log("Parsed application data:", applicationData);

        // Simple check for body presence
        if (Object.keys(applicationData).length === 0 && !event.body) {
             return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Application data is missing"
                })
            };
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
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Job posting not found"
                })
            };
        }

        // Extract clinicId from the job posting
        const clinicIdFromJob: string | undefined = jobExists.Item.clinicUserSub?.S;
        // In the original JS, clinicIdFromJob is sometimes referred to as 'clinicId' and sometimes as 'clinicUserSub' 
        // in the Key for CLINIC_PROFILES_TABLE. We assume clinicUserSub is the correct identifier for the clinic profile.
        if (!clinicIdFromJob) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Clinic ID (clinicUserSub) not found in job posting"
                })
            };
        }

        console.log("Clinic ID from job:", clinicIdFromJob);

        // Check if the job posting is active
        const jobStatus: string = jobExists.Item.status?.S || 'active';
        if (jobStatus !== 'active') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Cannot apply to ${jobStatus} job posting`
                })
            };
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
            return {
                statusCode: 409,
                body: JSON.stringify({
                    error: "You have already applied to this job"
                })
            };
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
        return {
            statusCode: 201,
            body: JSON.stringify({
                message: "Job application submitted successfully",
                applicationId,
                jobId: jobId,
                status: "pending",
                appliedAt: timestamp,
                job: jobInfo,
                clinic: clinicInfo
            })
        };
    }
    catch (error) {
        const err = error as Error;
        console.error("Error creating job application:", err);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to submit job application. Please try again.",
                details: err.message
            })
        };
    }
};
exports.handler = handler;