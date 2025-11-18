"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event);

        // Extract jobId from the proxy path (if using {proxy+})
        const pathParts = event.pathParameters?.proxy?.split('/'); // Split the path by '/'
        const jobId = pathParts?.[2]; // The jobId will be the third part of the path (index 2)

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        // Get the multi-day consulting job based on jobId
        const jobCommand = new client_dynamodb_1.GetItemCommand({
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

        // Verify it's a multi-day consulting job
        if (job.job_type?.S !== 'multi_day_consulting') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // Get application count for this job
        let applicationCount = 0;
        try {
            const applicationsCommand = new client_dynamodb_1.QueryCommand({
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

        // Fetch profile details from the Clinic Profiles Table
        const profileCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE, // Assuming clinic profiles are stored in this table
            Key: {
                clinicId: { S: job.clinicId?.S },
                userSub: { S: userSub }
            }
        });

        const profileResponse = await dynamodb.send(profileCommand);
        if (!profileResponse.Item) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "Profile not found for this clinic" })
            };
        }

        const clinicProfile = profileResponse.Item;
        const profileData = {
            bookingOutPeriod: clinicProfile.booking_out_period?.S || "immediate", // Default to "immediate"
            clinicSoftware: clinicProfile.clinic_software?.S || "Unknown", // Default to "Unknown"
            freeParkingAvailable: clinicProfile.free_parking_available?.BOOL || false,
            parkingType: clinicProfile.parking_type?.S || "N/A", // Default to "N/A"
            practiceType: clinicProfile.practice_type?.S || "General", // Default to "General"
            primaryPracticeArea: clinicProfile.primary_practice_area?.S || "General Dentistry"
        };

        // Format the multi-day consulting job response
        const consultingJob = {
            jobId: job.jobId?.S || '',
            jobType: job.job_type?.S || '',
            professionalRole: job.professional_role?.S || '',
            jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Consulting Position`,
            description: job.job_description?.S || '',
            requirements: job.requirements?.SS || [],
            dates: job.dates?.SS || [], // Multiple dates for consulting jobs
            startTime: job.start_time?.S || '',
            endTime: job.end_time?.S || '',
            mealBreak: job.meal_break?.BOOL || false,
            hourlyRate: job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0,
            totalDays: job.dates?.SS ? job.dates.SS.length : 0,
            addressLine1: job.addressLine1?.S || '',
            addressLine2: job.addressLine2?.S || '',
            addressLine3: job.addressLine3?.S || '',
            city: job.city?.S || '',
            state: job.state?.S || '',
            zipCode: job.zipCode?.S || '',
            status: job.status?.S || 'active',
            createdAt: job.createdAt?.S || '',
            updatedAt: job.updatedAt?.S || '',
            // Profile details added to the response
            bookingOutPeriod: profileData.bookingOutPeriod,
            clinicSoftware: profileData.clinicSoftware,
            freeParkingAvailable: profileData.freeParkingAvailable,
            parkingType: profileData.parkingType,
            practiceType: profileData.practiceType,
            primaryPracticeArea: profileData.primaryPracticeArea,
            // Application metrics
            applicationCount,
            applicationsEnabled: job.status?.S === 'active'
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Multi-day consulting job retrieved successfully",
                job: consultingJob
            })
        };
    } catch (error) {
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

exports.handler = handler;
