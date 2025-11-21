import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ----------------------
// TYPES
// ----------------------

interface DynamoItem {
    [key: string]: AttributeValue;
}

// Define CORS headers

// ----------------------
// Fetch job details
// ----------------------
const fetchJobDetails = async (jobId: string, userSub: string): Promise<DynamoItem> => {
    const jobCommand = new GetItemCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        Key: {
            clinicUserSub: { S: userSub },
            jobId: { S: jobId },
        },
    });

    const jobResponse = await dynamodb.send(jobCommand);
    if (!jobResponse.Item) {
        throw new Error("Job not found or access denied");
    }
    return jobResponse.Item as DynamoItem;
};

// ----------------------
// Fetch clinic details
// ----------------------
const fetchClinicDetails = async (clinicId: string, userSub: string): Promise<DynamoItem> => {
    const clinicCommand = new GetItemCommand({
        TableName: process.env.CLINIC_PROFILES_TABLE,
        Key: {
            clinicId: { S: clinicId },
            userSub: { S: userSub },
        },
    });

    const clinicResponse = await dynamodb.send(clinicCommand);
    if (!clinicResponse.Item) {
        throw new Error("Profile not found for this clinic");
    }
    return clinicResponse.Item as DynamoItem;
};

// ----------------------
// Fetch application count
// ----------------------
const fetchApplicationCount = async (jobId: string): Promise<number> => {
    let applicationCount = 0;

    try {
        const applicationsCommand = new QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
            },
            Select: "COUNT",
        });

        const applicationsResponse = await dynamodb.send(applicationsCommand);
        applicationCount = applicationsResponse.Count || 0;
    } catch (error) {
        console.warn("Failed to get application count:", error);
    }

    return applicationCount;
};

// ----------------------
// Main handler
// ----------------------
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Handle HTTP API (v2) structure where method is in requestContext.http
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    // Preflight
    if (method === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Extract Bearer token from Authorization header
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;

        // Extract jobId from proxy path or directly from pathParameters
        // Path structure usually: /jobs/{jobId} or /jobs/permanent/{jobId}
        let jobId = event.pathParameters?.jobId;

        if (!jobId && event.pathParameters?.proxy) {
             const pathParts = event.pathParameters.proxy.split("/");
             // Adjust index based on your routing. 
             // If path is /jobs/{id}, it might be index 1. 
             // If path is /jobs/permanent/{id}, it might be index 2.
             // Trying to grab the last segment is usually safe for ID lookups.
             jobId = pathParts[pathParts.length - 1];
             
             // Fallback logic from original code if specific index was intended (index 1)
             if (!jobId || jobId === 'permanent' || jobId === 'temporary') {
                 jobId = pathParts[1]; 
             }
        }

        if (!jobId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "jobId is required in path parameters",
                }),
            };
        }

        // Fetch job details
        const job = await fetchJobDetails(jobId, userSub);

        // Fetch clinic profile
        const clinicDetails = await fetchClinicDetails(job.clinicId?.S || "", userSub);

        const profileData = {
            bookingOutPeriod: clinicDetails.booking_out_period?.S || "immediate",
            clinicSoftware: clinicDetails.clinic_software?.S || "Unknown",
            freeParkingAvailable: clinicDetails.free_parking_available?.BOOL || false,
            parkingType: clinicDetails.parking_type?.S || "N/A",
            practiceType: clinicDetails.practice_type?.S || "General",
            primaryPracticeArea: clinicDetails.primary_practice_area?.S || "General Dentistry",
        };

        const applicationCount = await fetchApplicationCount(jobId);

        let jobResponse: any = {
            jobId: job.jobId?.S || "",
            jobType: job.job_type?.S || "",
            professionalRole: job.professional_role?.S || "",
            jobTitle: job.job_title?.S || `${job.professional_role?.S || "Professional"} Position`,
            description: job.job_description?.S || "",
            requirements: job.requirements?.SS || [],
            status: job.status?.S || "active",
            createdAt: job.createdAt?.S || "",
            updatedAt: job.updatedAt?.S || "",
            applicationCount,
            applicationsEnabled: job.status?.S === "active",
            practiceType: profileData.practiceType,
            primaryPracticeArea: profileData.primaryPracticeArea,
            clinicSoftware: profileData.clinicSoftware,
            freeParkingAvailable: profileData.freeParkingAvailable,
            parkingType: profileData.parkingType,
            bookingOutPeriod: profileData.bookingOutPeriod,
        };

        // ----------------------
        // Job type specific
        // ----------------------
        if (job.job_type?.S === "temporary") {
            jobResponse.date = job.date?.S || "";
            jobResponse.startTime = job.start_time?.S || "";
            jobResponse.endTime = job.end_time?.S || "";
            jobResponse.hourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0;
            jobResponse.mealBreak = job.meal_break?.BOOL || false;
            jobResponse.city = job.city?.S || "";
            jobResponse.state = job.state?.S || "";
            jobResponse.pincode = job.pincode?.S || "";
        } else if (job.job_type?.S === "multi_day_consulting") {
            // keep dates array or empty array
            jobResponse.dates = job.dates?.SS || [];
            jobResponse.startTime = job.start_time?.S || "";
            jobResponse.endTime = job.end_time?.S || "";
            jobResponse.hourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0;

            // FIX: normalize before getting length so TypeScript cannot complain
            jobResponse.totalDays = (job.dates?.SS ?? []).length;
        } else if (job.job_type?.S === "permanent") {
            jobResponse.salaryMin = job.salary_min?.N ? parseFloat(job.salary_min.N) : 0;
            jobResponse.salaryMax = job.salary_max?.N ? parseFloat(job.salary_max.N) : 0;
            jobResponse.benefits = job.benefits?.SS || [];
        }

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 200,
                message: `${job.job_type?.S} job retrieved successfully`,
                data: jobResponse,
                timestamp: new Date().toISOString()
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving job posting:", error);
        const errorMessage = error instanceof Error ? error.message : "An unknown error occurred";
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Internal Server Error",
                statusCode: 500,
                message: "Failed to retrieve job posting",
                details: { reason: errorMessage },
                timestamp: new Date().toISOString()
            }),
        };
    }
};