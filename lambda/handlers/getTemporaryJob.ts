import {
  DynamoDBClient,
  GetItemCommand,
  QueryCommand,
  AttributeValue
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle HTTP API (v2) structure where method is in requestContext.http
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;

    // CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        const userSub = await validateToken(event);

        // Extract jobId from the proxy path (if using {proxy+})
        // Expected structure: /jobs/temporary/{jobId}
        const pathParts = event.pathParameters?.proxy?.split('/');
        const jobId: string | undefined = pathParts?.[2];

        if (!jobId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Job ID is required",
                details: { pathFormat: "/jobs/temporary/{jobId}" },
                timestamp: new Date().toISOString()
            });
        }

        // Get the temporary job
        const jobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });

        const jobResponse = await dynamodb.send(jobCommand);
        if (!jobResponse.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Temporary job not found",
                details: { jobId: jobId },
                timestamp: new Date().toISOString()
            });
        }

        const job = jobResponse.Item;

        // Verify it's a temporary job
        if (job.job_type?.S !== "temporary") {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid job type",
                details: { expected: "temporary", received: job.job_type?.S },
                timestamp: new Date().toISOString()
            });
        }

        // Clinic address
        const clinicAddress = {
            city: job.city?.S || "",
            state: job.state?.S || "",
            pincode: job.pincode?.S || ""
        };

        // Application count
        let applicationCount = 0;
        try {
            const applicationsCommand = new QueryCommand({
                TableName: process.env.JOB_APPLICATIONS_TABLE,
                KeyConditionExpression: "jobId = :jobId",
                ExpressionAttributeValues: {
                    ":jobId": { S: jobId }
                },
                Select: "COUNT"
            });

            const applicationsResponse = await dynamodb.send(applicationsCommand);
            applicationCount = applicationsResponse.Count || 0;
        } catch (error) {
            console.warn("Failed to get application count:", error);
        }

        // Fetch profile details from Clinic Profiles Table
        const profileCommand = new GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: { S: job.clinicId?.S || "" },
                userSub: { S: userSub }
            }
        });

        const profileResponse = await dynamodb.send(profileCommand);
        if (!profileResponse.Item) {
            return json(404, {
                error: "Not Found",
                statusCode: 404,
                message: "Clinic profile not found",
                details: { clinicId: job.clinicId?.S },
                timestamp: new Date().toISOString()
            });
        }

        const clinicProfile = profileResponse.Item;

        const profileData = {
            bookingOutPeriod: clinicProfile.booking_out_period?.S || "immediate",
            practiceType: clinicProfile.practice_type?.S || "Unknown",
            primaryPracticeArea: clinicProfile.primary_practice_area?.S || "General",
            clinicSoftware: clinicProfile.clinic_software?.S || "Unknown",
            freeParkingAvailable: clinicProfile.free_parking_available?.BOOL || false,
            parkingType: clinicProfile.parking_type?.S || "N/A"
        };

        // Format final response
        const temporaryJob = {
            jobId: job.jobId?.S || "",
            jobType: job.job_type?.S || "",
            professionalRole: job.professional_role?.S || "",
            jobTitle: job.job_title?.S || `${job.professional_role?.S || "Professional"} Position`,
            description: job.job_description?.S || "",
            requirements: job.requirements?.SS || [],
            date: job.date?.S || "",
            startTime: job.start_time?.S || "",
            endTime: job.end_time?.S || "",
            hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0,
            mealBreak: job.meal_break?.BOOL || false,
            parkingInfo: job.parking_info?.S || "",
            addressLine1: job.addressLine1?.S || "",
            addressLine2: job.addressLine2?.S || "",
            addressLine3: job.addressLine3?.S || "",
            fullAddress:
                job.fullAddress?.S ||
                `${job.addressLine1?.S || ""} ${job.addressLine2?.S || ""} ${job.addressLine3?.S || ""}`,
            status: job.status?.S || "active",
            createdAt: job.createdAt?.S || "",
            updatedAt: job.updatedAt?.S || "",
            applicationCount,
            applicationsEnabled: job.status?.S === "active",

            // Clinic Address
            city: clinicAddress.city,
            state: clinicAddress.state,
            pincode: clinicAddress.pincode,

            // Profile Data
            practiceType: profileData.practiceType,
            primaryPracticeArea: profileData.primaryPracticeArea,
            clinicSoftware: profileData.clinicSoftware,
            freeParkingAvailable: profileData.freeParkingAvailable,
            parkingType: profileData.parkingType,
            bookingOutPeriod: profileData.bookingOutPeriod
        };

        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Temporary job retrieved successfully",
            data: { job: temporaryJob },
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Error retrieving temporary job:", error);
        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to retrieve temporary job",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};