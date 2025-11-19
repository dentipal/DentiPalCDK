"use strict";
import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ----------------------
// TYPES
// ----------------------

interface DynamoItem {
    [key: string]: AttributeValue;
}

interface LambdaEvent {
    pathParameters?: {
        proxy?: string;
    };
    headers?: {
        Authorization?: string;
    };
    body?: string;
    [key: string]: any;
}

interface LambdaResponse {
    statusCode: number;
    body: string;
}

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
export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        const userSub = await validateToken(event);

        const pathParts = event.pathParameters?.proxy?.split("/");
        const jobId = pathParts?.[1];

        if (!jobId) {
            return {
                statusCode: 400,
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
            body: JSON.stringify({
                message: `${job.job_type?.S} job retrieved successfully`,
                job: jobResponse,
            }),
        };
    } catch (error: any) {
        console.error("Error retrieving job posting:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve job posting. Please try again.",
                details: error.message,
            }),
        };
    }
};
