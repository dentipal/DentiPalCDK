"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const { DynamoDBClient, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = await validateToken(event);
        const pathParts = event.pathParameters?.proxy?.split('/');
        const jobId = pathParts?.[2]; // Extract the jobId from the proxy path

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*", // Allow cross-origin requests
                    "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allow CORS headers
                }
            };
        }

        // Fetch the multiday consulting job details using the jobId
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
                    error: "Multiday job not found or access denied"
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }

        const job = jobResponse.Item;

        // Ensure this is a multiday consulting job
        if (job.job_type?.S !== 'multi_day_consulting') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                }),
                headers: {
                    "Access-Control-Allow-Origin": "*",
                    "Access-Control-Allow-Headers": "Content-Type, Authorization",
                }
            };
        }

        // Format the multiday job response
        const multidayJob = {
            jobId: job.jobId?.S || '',
            jobType: job.job_type?.S || '',
            professionalRole: job.professional_role?.S || '',
            shiftSpeciality: job.shift_speciality?.S || '',
            employmentType: job.employment_type?.S || '',
            salaryMin: job.salary_min?.N ? parseFloat(job.salary_min.N) : 0,
            salaryMax: job.salary_max?.N ? parseFloat(job.salary_max.N) : 0,
            benefits: job.benefits?.SS || [],
            status: job.status?.S || 'active',
            addressLine1: job.addressLine1?.S || '',
            addressLine2: job.addressLine2?.S || '',
            addressLine3: job.addressLine3?.S || '',
            fullAddress: `${job.addressLine1?.S || ''} ${job.addressLine2?.S || ''} ${job.addressLine3?.S || ''}`,
            city: job.city?.S || '',
            state: job.state?.S || '',
            pincode: job.pincode?.S || '',
            bookingOutPeriod: job.bookingOutPeriod?.S || "immediate",
            clinicSoftware: job.clinicSoftware?.S || "Unknown",
            freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
            parkingType: job.parkingType?.S || "N/A",
            practiceType: job.practiceType?.S || "General",
            primaryPracticeArea: job.primaryPracticeArea?.S || "General Dentistry",
            createdAt: job.createdAt?.S || '',
            updatedAt: job.updatedAt?.S || '',
            // Include the dates field
            dates: job.dates?.SS || [] // Add this to include the dates field
        };

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Multiday consulting job retrieved successfully",
                job: multidayJob
            }),
            headers: {
                "Access-Control-Allow-Origin": "*", // Allow cross-origin requests
                "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allow CORS headers
            }
        };

    } catch (error) {
        console.error("Error retrieving multiday consulting job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to retrieve multiday consulting job. Please try again.",
                details: error.message
            }),
            headers: {
                "Access-Control-Allow-Origin": "*", // Allow cross-origin requests
                "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allow CORS headers
            }
        };
    }
};

exports.handler = handler;
