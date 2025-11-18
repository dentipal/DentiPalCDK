"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    // Define CORS headers
    const corsHeaders = {
        "Access-Control-Allow-Origin": "*"
    };

    try {
        const userSub = (0, utils_1.validateToken)(event);
        console.log("userSub:", userSub); // Debugging log for userSub

        // Extract jobId from the 'proxy' path parameter
        const pathParts = event.pathParameters?.proxy?.split('/');
        const jobId = pathParts?.[2]; // jobId will be the third part of the path (index 2)

        console.log("Extracted jobId from path:", jobId); // Debugging log for jobId

        if (!jobId) {
            return {
                statusCode: 400,
                headers: corsHeaders, // Add CORS headers
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        // Verify the job exists and belongs to the clinic
        const getJobCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });

        const jobResponse = await dynamodb.send(getJobCommand);

        // Debugging log for jobResponse
        console.log("jobResponse:", jobResponse);

        // Check if job was found
        if (!jobResponse.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders, // Add CORS headers
                body: JSON.stringify({
                    error: "Temporary job not found or access denied"
                })
            };
        }

        const job = jobResponse.Item;

        // Verify it's a temporary job
        if (job.job_type?.S !== 'temporary') {
            return {
                statusCode: 400,
                headers: corsHeaders, // Add CORS headers
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // Check if there are active applications
        const applicationsCommand = new client_dynamodb_1.QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            KeyConditionExpression: "jobId = :jobId",
            FilterExpression: "applicationStatus IN (:pending, :accepted, :negotiating)",
            ExpressionAttributeValues: {
                ":jobId": { S: jobId },
                ":pending": { S: "pending" },
                ":accepted": { S: "accepted" },
                ":negotiating": { S: "negotiating" }
            }
        });

        const applicationsResponse = await dynamodb.send(applicationsCommand);
        const activeApplications = applicationsResponse.Items || [];

        // Debugging log for active applications
        console.log("activeApplications:", activeApplications);

        // If there are active applications, update them to "job_cancelled" instead of deleting
        if (activeApplications.length > 0) {
            console.log(`Found ${activeApplications.length} active applications for job ${jobId}. Updating their status.`);
            for (const application of activeApplications) {
                try {
                    await dynamodb.send(new client_dynamodb_1.UpdateItemCommand({
                        TableName: process.env.JOB_APPLICATIONS_TABLE,
                        Key: {
                            jobId: { S: jobId },
                            applicationId: { S: application.applicationId?.S || '' }
                        },
                        UpdateExpression: "SET applicationStatus = :status, updatedAt = :updatedAt",
                        ExpressionAttributeValues: {
                            ":status": { S: "job_cancelled" },
                            ":updatedAt": { S: new Date().toISOString() }
                        }
                    }));
                }
                catch (updateError) {
                    console.warn(`Failed to update application ${application.applicationId?.S}:`, updateError);
                }
            }
        }

        // Delete the job
        const deleteCommand = new client_dynamodb_1.DeleteItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });
        await dynamodb.send(deleteCommand);

        return {
            statusCode: 200,
            headers: corsHeaders, // Add CORS headers
            body: JSON.stringify({
                message: "Temporary job deleted successfully",
                jobId,
                affectedApplications: activeApplications.length,
                applicationHandling: activeApplications.length > 0 ?
                    "Active applications have been marked as 'job_cancelled'" :
                    "No active applications were affected"
            })
        };
    }
    catch (error) {
        console.error("Error deleting temporary job:", error);
        return {
            statusCode: 500,
            headers: corsHeaders, // Add CORS headers
            body: JSON.stringify({
                error: "Failed to delete temporary job. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;