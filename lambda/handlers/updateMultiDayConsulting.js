"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        // Validate the token and get the userSub
        const userSub = (0, utils_1.validateToken)(event);

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
        const getJobCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        });
        const jobResponse = await dynamodb.send(getJobCommand);
        if (!jobResponse.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Multi-day consulting job not found or access denied"
                })
            };
        }
        const existingJob = jobResponse.Item;

        // Verify it's a multi-day consulting job
        if (existingJob.job_type?.S !== 'multi_day_consulting') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a multi-day consulting job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // Parse the incoming update data
        const updateData = JSON.parse(event.body);

        // Build update expression and attribute values
        const updateExpressions = [];
        const attributeNames = {};
        const attributeValues = {};

        // Always update the timestamp
        updateExpressions.push("#updatedAt = :updatedAt");
        attributeNames["#updatedAt"] = "updated_at";
        attributeValues[":updatedAt"] = { S: new Date().toISOString() };

        // Handle editable fields
        if (updateData.professionalRole !== undefined) {
            updateExpressions.push("#professionalRole = :professionalRole");
            attributeNames["#professionalRole"] = "professional_role";
            attributeValues[":professionalRole"] = { S: updateData.professionalRole };
        }
        if (updateData.jobTitle !== undefined) {
            updateExpressions.push("#jobTitle = :jobTitle");
            attributeNames["#jobTitle"] = "job_title";
            attributeValues[":jobTitle"] = { S: updateData.jobTitle };
        }
        if (updateData.description !== undefined) {
            updateExpressions.push("#description = :description");
            attributeNames["#description"] = "description";
            attributeValues[":description"] = { S: updateData.description };
        }
        if (updateData.requirements !== undefined) {
            updateExpressions.push("#requirements = :requirements");
            attributeNames["#requirements"] = "requirements";
            attributeValues[":requirements"] = { SS: updateData.requirements };
        }
        if (updateData.dates !== undefined) {
            updateExpressions.push("#dates = :dates");
            attributeNames["#dates"] = "dates";
            attributeValues[":dates"] = { SS: updateData.dates };
        }
        if (updateData.startTime !== undefined) {
            updateExpressions.push("#startTime = :startTime");
            attributeNames["#startTime"] = "start_time";
            attributeValues[":startTime"] = { S: updateData.startTime };
        }
        if (updateData.endTime !== undefined) {
            updateExpressions.push("#endTime = :endTime");
            attributeNames["#endTime"] = "end_time";
            attributeValues[":endTime"] = { S: updateData.endTime };
        }
        if (updateData.mealBreak !== undefined) {
            updateExpressions.push("#mealBreak = :mealBreak");
            attributeNames["#mealBreak"] = "meal_break";
            attributeValues[":mealBreak"] = { BOOL: updateData.mealBreak };
        }
        if (updateData.hourlyRate !== undefined) {
            updateExpressions.push("#hourlyRate = :hourlyRate");
            attributeNames["#hourlyRate"] = "hourly_rate";
            attributeValues[":hourlyRate"] = { N: updateData.hourlyRate.toString() };
        }
        if (updateData.totalDays !== undefined) {
            updateExpressions.push("#totalDays = :totalDays");
            attributeNames["#totalDays"] = "total_days";
            attributeValues[":totalDays"] = { N: updateData.totalDays.toString() };
        }

        // Update the job
        const updateCommand = new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            },
            UpdateExpression: `SET ${updateExpressions.join(", ")}`,
            ExpressionAttributeNames: attributeNames,
            ExpressionAttributeValues: attributeValues,
            ReturnValues: "ALL_NEW"
        });
        const updateResponse = await dynamodb.send(updateCommand);
        const updatedJob = updateResponse.Attributes;

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Multi-day consulting job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || '',
                    jobType: updatedJob?.job_type?.S || '',
                    professionalRole: updatedJob?.professional_role?.S || '',
                    jobTitle: updatedJob?.job_title?.S || '',
                    description: updatedJob?.description?.S || '',
                    requirements: updatedJob?.requirements?.SS || [],
                    dates: updatedJob?.dates?.SS || [],
                    startTime: updatedJob?.start_time?.S || '',
                    endTime: updatedJob?.end_time?.S || '',
                    hourlyRate: updatedJob?.hourly_rate?.N ? parseFloat(updatedJob.hourly_rate.N) : 0,
                    totalDays: updatedJob?.total_days?.N ? parseInt(updatedJob.total_days.N) : 0,
                    mealBreak: updatedJob?.meal_break?.BOOL || false,
                    status: updatedJob?.status?.S || 'active',
                    updatedAt: updatedJob?.updated_at?.S || ''
                }
            })
        };
    } catch (error) {
        console.error("Error updating multi-day consulting job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to update multi-day consulting job. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;
