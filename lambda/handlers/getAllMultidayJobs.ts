import {
    DynamoDBClient,
    GetItemCommand,
    AttributeValue,
    GetItemCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Changed import to use the new token utility
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });


// Simplified interface for a DynamoDB Item
interface DynamoDBJobItem {
    jobId?: AttributeValue;
    job_type?: AttributeValue;
    clinicUserSub?: AttributeValue;
    professional_role?: AttributeValue;
    shift_speciality?: AttributeValue;
    employment_type?: AttributeValue;
    salary_min?: AttributeValue;
    salary_max?: AttributeValue;
    benefits?: AttributeValue; // SS
    status?: AttributeValue;
    addressLine1?: AttributeValue;
    addressLine2?: AttributeValue;
    addressLine3?: AttributeValue;
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    bookingOutPeriod?: AttributeValue;
    clinicSoftware?: AttributeValue;
    freeParkingAvailable?: AttributeValue; // BOOL
    parkingType?: AttributeValue;
    practiceType?: AttributeValue;
    primaryPracticeArea?: AttributeValue;
    createdAt?: AttributeValue;
    updatedAt?: AttributeValue;
    dates?: AttributeValue; // SS
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped job object
interface MultidayJobResponse {
    jobId: string;
    jobType: string;
    professionalRole: string;
    shiftSpeciality: string;
    employmentType: string;
    salaryMin: number;
    salaryMax: number;
    benefits: string[]; // SS mapped to string[]
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
    createdAt: string;
    updatedAt: string;
    dates: string[]; // SS mapped to string[]
}

/**
 * AWS Lambda handler to retrieve a specific multi-day consulting job by ID.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        
        // 2. Extract jobId from the proxy path
        const pathParts = event.pathParameters?.proxy?.split('/');
        // Assumes path is something like /jobs/multiday/{jobId}
        const jobId = pathParts?.[2];

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "jobId is required in path parameters" }),
                headers: CORS_HEADERS, 
            };
        }

        // 3. Fetch the multiday consulting job details
        // Uses clinicUserSub (PK) and jobId (SK) for a direct GetItem
        // Note: This query assumes 'userSub' here is the CLINIC's sub. 
        // If a professional is viewing this, you can't use 'userSub' as the PK.
        // Assuming the intention is for a clinic to view their own job:
        const jobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });

        const jobResponse: GetItemCommandOutput = await dynamodb.send(jobCommand);
        const job = jobResponse.Item as DynamoDBJobItem | undefined;
        
        if (!job) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Multiday job not found or access denied" }),
                headers: CORS_HEADERS, 
            };
        }

        // 4. Ensure this is the correct job type
        if (job.job_type?.S !== 'multi_day_consulting') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                }),
                headers: CORS_HEADERS, 
            };
        }

        // 5. Format the multiday job response, transforming DynamoDB types
        const multidayJob: MultidayJobResponse = {
            jobId: job.jobId?.S || '',
            jobType: job.job_type?.S || '',
            professionalRole: job.professional_role?.S || '',
            shiftSpeciality: job.shift_speciality?.S || '',
            employmentType: job.employment_type?.S || '',
            
            // Number (N) type to float
            salaryMin: job.salary_min?.N ? parseFloat(job.salary_min.N) : 0,
            salaryMax: job.salary_max?.N ? parseFloat(job.salary_max.N) : 0,
            
            // String Set (SS) type to string array
            benefits: job.benefits?.SS || [],
            dates: job.dates?.SS || [],
            
            status: job.status?.S || 'active',
            addressLine1: job.addressLine1?.S || '',
            addressLine2: job.addressLine2?.S || '',
            addressLine3: job.addressLine3?.S || '',
            
            // Combine address lines
            fullAddress: `${job.addressLine1?.S || ''} ${job.addressLine2?.S || ''} ${job.addressLine3?.S || ''}`.trim(),
            
            city: job.city?.S || '',
            state: job.state?.S || '',
            pincode: job.pincode?.S || '',
            bookingOutPeriod: job.bookingOutPeriod?.S || "immediate",
            clinicSoftware: job.clinicSoftware?.S || "Unknown",
            
            // Boolean (BOOL) type
            freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
            
            parkingType: job.parkingType?.S || "N/A",
            practiceType: job.practiceType?.S || "General",
            primaryPracticeArea: job.primaryPracticeArea?.S || "General Dentistry",
            createdAt: job.createdAt?.S || '',
            updatedAt: job.updatedAt?.S || '',
        };

        // 6. Success Response
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Multiday consulting job retrieved successfully",
                job: multidayJob
            }),
            headers: CORS_HEADERS, 
        };

    } catch (error: any) {
        console.error("Error retrieving multiday consulting job:", error);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                body: JSON.stringify({ 
                    error: "Unauthorized", 
                    details: error.message 
                }),
                headers: CORS_HEADERS, 
            };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve multiday consulting job. Please try again.",
                details: error.message
            }),
            headers: CORS_HEADERS, 
        };
    }
};