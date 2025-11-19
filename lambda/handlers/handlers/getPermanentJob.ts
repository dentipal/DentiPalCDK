import {
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
} from "aws-lambda";

import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandInput,
} from "@aws-sdk/client-dynamodb";

import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    try {
        const userSub = await validateToken(event);

        const pathParts = event.pathParameters?.proxy?.split("/");
        const jobId = pathParts?.[2];

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters",
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
            };
        }

        const jobCommand: GetItemCommandInput = {
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId },
            },
        };

        const jobResponse = await dynamodb.send(new GetItemCommand(jobCommand));

        if (!jobResponse.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Permanent job not found or access denied",
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
            };
        }

        const job = jobResponse.Item;

        if (job.job_type?.S !== "permanent") {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error:
                        "This is not a permanent job. Use the appropriate endpoint for this job type.",
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                },
            };
        }

        const permanentJob = {
            jobId: job.jobId?.S || "",
            jobType: job.job_type?.S || "",
            professionalRole: job.professional_role?.S || "",
            shiftSpeciality: job.shift_speciality?.S || "",
            employmentType: job.employment_type?.S || "",
            salaryMin: job.salary_min?.N ? parseFloat(job.salary_min.N) : 0,
            salaryMax: job.salary_max?.N ? parseFloat(job.salary_max.N) : 0,
            benefits: job.benefits?.SS || [],
            status: job.status?.S || "active",

            addressLine1: job.addressLine1?.S || "",
            addressLine2: job.addressLine2?.S || "",
            addressLine3: job.addressLine3?.S || "",
            fullAddress: `${job.addressLine1?.S || ""} ${job.addressLine2?.S || ""} ${job.addressLine3?.S || ""}`,

            city: job.city?.S || "",
            state: job.state?.S || "",
            pincode: job.pincode?.S || "",

            bookingOutPeriod: job.bookingOutPeriod?.S || "immediate",
            clinicSoftware: job.clinicSoftware?.S || "Unknown",
            freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
            parkingType: job.parkingType?.S || "N/A",
            practiceType: job.practiceType?.S || "General",
            primaryPracticeArea: job.primaryPracticeArea?.S || "General Dentistry",

            createdAt: job.createdAt?.S || "",
            updatedAt: job.updatedAt?.S || "",
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Permanent job retrieved successfully",
                job: permanentJob,
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
        };
    } catch (error: any) {
        console.error("Error retrieving permanent job:", error);

        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve permanent job. Please try again.",
                details: error.message,
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            },
        };
    }
};
