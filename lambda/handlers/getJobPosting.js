"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

// Function to fetch job details by jobId and clinic user subscription (userSub)
const fetchJobDetails = async (jobId, userSub) => {
    const jobCommand = new client_dynamodb_1.GetItemCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        Key: {
            clinicUserSub: { S: userSub },
            jobId: { S: jobId }
        }
    });

    const jobResponse = await dynamodb.send(jobCommand);
    if (!jobResponse.Item) {
        throw new Error("Job not found or access denied");
    }
    return jobResponse.Item;
};

// Function to fetch clinic details
const fetchClinicDetails = async (clinicId, userSub) => {
    const clinicCommand = new client_dynamodb_1.GetItemCommand({
        TableName: process.env.CLINIC_PROFILES_TABLE,
        Key: {
            clinicId: { S: clinicId },
            userSub: { S: userSub }
        }
    });

    const clinicResponse = await dynamodb.send(clinicCommand);
    if (!clinicResponse.Item) {
        throw new Error("Profile not found for this clinic");
    }
    return clinicResponse.Item;
};

// Function to fetch application count
const fetchApplicationCount = async (jobId) => {
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
    return applicationCount;
};

// Main handler for fetching job details based on job type
const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user

        // Extract jobId from the proxy path (splitting the URL path)
        const pathParts = event.pathParameters?.proxy?.split('/'); 
        const jobId = pathParts?.[1]; // The jobId should be the second part of the path (index 1)

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        // Fetch job details
        const job = await fetchJobDetails(jobId, userSub);

        // Fetch clinic and profile details
        const clinicDetails = await fetchClinicDetails(job.clinicId?.S || '', userSub);
        const profileData = {
            bookingOutPeriod: clinicDetails.booking_out_period?.S || "immediate",
            clinicSoftware: clinicDetails.clinic_software?.S || "Unknown",
            freeParkingAvailable: clinicDetails.free_parking_available?.BOOL || false,
            parkingType: clinicDetails.parking_type?.S || "N/A",
            practiceType: clinicDetails.practice_type?.S || "General",
            primaryPracticeArea: clinicDetails.primary_practice_area?.S || "General Dentistry"
        };

        // Get application count
        const applicationCount = await fetchApplicationCount(jobId);

        // Format job response based on job type
        let jobResponse = {
            jobId: job.jobId?.S || '',
            jobType: job.job_type?.S || '',
            professionalRole: job.professional_role?.S || '',
            jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Position`,
            description: job.job_description?.S || '',
            requirements: job.requirements?.SS || [],
            status: job.status?.S || 'active',
            createdAt: job.createdAt?.S || '',
            updatedAt: job.updatedAt?.S || '',
            applicationCount,
            applicationsEnabled: job.status?.S === 'active',
            practiceType: profileData.practiceType,
            primaryPracticeArea: profileData.primaryPracticeArea,
            clinicSoftware: profileData.clinicSoftware,
            freeParkingAvailable: profileData.freeParkingAvailable,
            parkingType: profileData.parkingType,
            bookingOutPeriod: profileData.bookingOutPeriod
        };

        // For job type specific data
        if (job.job_type?.S === 'temporary') {
            jobResponse.date = job.date?.S || '';
            jobResponse.startTime = job.start_time?.S || '';
            jobResponse.endTime = job.end_time?.S || '';
            jobResponse.hourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0;
            jobResponse.mealBreak = job.meal_break?.BOOL || false;
            jobResponse.city = job.city?.S || '';
            jobResponse.state = job.state?.S || '';
            jobResponse.pincode = job.pincode?.S || '';
        } else if (job.job_type?.S === 'multi_day_consulting') {
            jobResponse.dates = job.dates?.SS || [];
            jobResponse.startTime = job.start_time?.S || '';
            jobResponse.endTime = job.end_time?.S || '';
            jobResponse.hourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : 0;
            jobResponse.totalDays = job.dates?.SS.length || 0;
        } else if (job.job_type?.S === 'permanent') {
            jobResponse.salaryMin = job.salary_min?.N ? parseFloat(job.salary_min.N) : 0;
            jobResponse.salaryMax = job.salary_max?.N ? parseFloat(job.salary_max.N) : 0;
            jobResponse.benefits = job.benefits?.SS || [];
        }

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: `${job.job_type?.S} job retrieved successfully`,
                job: jobResponse
            })
        };
    } catch (error) {
        console.error("Error retrieving job posting:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve job posting. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;
