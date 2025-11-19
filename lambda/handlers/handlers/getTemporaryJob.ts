import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { validateToken } from "./utils";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

export const handler = async (event: any): Promise<any> => {
    try {
        // Validate token and handle invalid/missing auth explicitly
        let userSub: string;
        try {
            userSub = validateToken(event);
        } catch (authErr: any) {
            console.warn("Token validation failed:", authErr);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "Forbidden: invalid or missing authorization" }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }

        // Extract jobId from the proxy path (if using {proxy+})
        const pathParts = event.pathParameters?.proxy?.split('/');
        const jobId: string | undefined = pathParts?.[2];

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
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
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Temporary job not found or access denied"
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }

        const job = jobResponse.Item;

        // Verify it's a temporary job
        if (job.job_type?.S !== "temporary") {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type."
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
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
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Profile not found for this clinic" }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
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

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Temporary job retrieved successfully",
                job: temporaryJob
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
        };
    } catch (error: any) {
        console.error("Error retrieving temporary job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve temporary job. Please try again.",
                details: error.message
            }),
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Headers": "Content-Type, Authorization",
            }
        };
    }
};
