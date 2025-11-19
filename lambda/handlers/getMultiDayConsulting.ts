"use strict";
import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ---------------------------
// Types
// ---------------------------
interface LambdaEvent {
    pathParameters?: {
        proxy?: string;
    };
    headers?: {
        Authorization?: string;
    };
    requestContext?: any;
    body?: string;
    [key: string]: any;
}

interface LambdaResponse {
    statusCode: number;
    body: string;
}

interface DynamoItem {
    [key: string]: AttributeValue;
}

// ---------------------------
// Handler
// ---------------------------
export const handler = async (event: LambdaEvent): Promise<LambdaResponse> => {
    try {
        const userSub = await validateToken(event);

        const pathParts = event.pathParameters?.proxy?.split("/");
        const jobId = pathParts?.[2];

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        const jobCommand = new GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });

        const jobResponse = await dynamodb.send(jobCommand);

        if (!jobResponse.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Multi-day consulting job not found or access denied"
                })
            };
        }

        const job = jobResponse.Item;

        if (job.job_type?.S !== "multi_day_consulting") {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error:
                        "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                })
            };
        }

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

        const profileCommand = new GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: { S: job.clinicId?.S || "" },
                userSub: { S: userSub }
            }
        });

        const profileResponse = await dynamodb.send(profileCommand);

        if (!profileResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Profile not found for this clinic"
                })
            };
        }

        const clinicProfile = profileResponse.Item as DynamoItem;

        const profileData = {
            bookingOutPeriod: clinicProfile.booking_out_period?.S || "immediate",
            clinicSoftware: clinicProfile.clinic_software?.S || "Unknown",
            freeParkingAvailable: clinicProfile.free_parking_available?.BOOL || false,
            parkingType: clinicProfile.parking_type?.S || "N/A",
            practiceType: clinicProfile.practice_type?.S || "General",
            primaryPracticeArea:
                clinicProfile.primary_practice_area?.S || "General Dentistry"
        };

        const consultingJob = {
            jobId: job.jobId?.S || "",
            jobType: job.job_type?.S || "",
            professionalRole: job.professional_role?.S || "",
            jobTitle:
                job.job_title?.S ||
                `${job.professional_role?.S || "Professional"} Consulting Position`,
            description: job.job_description?.S || "",
            requirements: job.requirements?.SS || [],
            dates: job.dates?.SS || [],
            startTime: job.start_time?.S || "",
            endTime: job.end_time?.S || "",
            mealBreak: job.meal_break?.BOOL || false,
            hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0,
            totalDays: job.dates?.SS ? job.dates.SS.length : 0,
            addressLine1: job.addressLine1?.S || "",
            addressLine2: job.addressLine2?.S || "",
            addressLine3: job.addressLine3?.S || "",
            city: job.city?.S || "",
            state: job.state?.S || "",
            zipCode: job.zipCode?.S || "",
            status: job.status?.S || "active",
            createdAt: job.createdAt?.S || "",
            updatedAt: job.updatedAt?.S || "",
            bookingOutPeriod: profileData.bookingOutPeriod,
            clinicSoftware: profileData.clinicSoftware,
            freeParkingAvailable: profileData.freeParkingAvailable,
            parkingType: profileData.parkingType,
            practiceType: profileData.practiceType,
            primaryPracticeArea: profileData.primaryPracticeArea,
            applicationCount,
            applicationsEnabled: job.status?.S === "active"
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Multi-day consulting job retrieved successfully",
                job: consultingJob
            })
        };
    } catch (error: any) {
        console.error("Error retrieving multi-day consulting job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve multi-day consulting job. Please try again.",
                details: error.message
            })
        };
    }
};
