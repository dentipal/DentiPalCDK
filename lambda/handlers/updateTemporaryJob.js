"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user
        
        // Extract jobId from the proxy path (assuming the path is something like "/jobs/{jobId}")
        const pathParts = event.pathParameters?.proxy?.split('/'); // Split path by '/'
        const jobId = pathParts?.[2]; // jobId will be the third part of the path (index 2)
        
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        const updateData = JSON.parse(event.body);

        // Verify the job exists and belongs to the clinic
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
                    error: "Temporary job not found or access denied"
                })
            };
        }
        const existingJob = jobResponse.Item;

        // Verify it's a temporary job
        if (existingJob.job_type?.S !== 'temporary') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a temporary job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // Build update expression
        const updateExpressions = [];
        const attributeNames = {};
        const attributeValues = {};

        // Always update the timestamp
        updateExpressions.push("#updatedAt = :updatedAt");
        attributeNames["#updatedAt"] = "updated_at";
        attributeValues[":updatedAt"] = { S: new Date().toISOString() };

        // Handle optional fields
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
        if (updateData.date !== undefined) {
            updateExpressions.push("#date = :date");
            attributeNames["#date"] = "date";
            attributeValues[":date"] = { S: updateData.date };
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
        if (updateData.hourlyRate !== undefined) {
            updateExpressions.push("#hourlyRate = :hourlyRate");
            attributeNames["#hourlyRate"] = "hourly_rate";
            attributeValues[":hourlyRate"] = { N: updateData.hourlyRate.toString() };
        }
        if (updateData.mealBreak !== undefined) {
            updateExpressions.push("#mealBreak = :mealBreak");
            attributeNames["#mealBreak"] = "meal_break";
            attributeValues[":mealBreak"] = { BOOL: updateData.mealBreak };
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
                message: "Temporary job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || '',
                    jobType: updatedJob?.job_type?.S || '',
                    professionalRole: updatedJob?.professional_role?.S || '',
                    jobTitle: updatedJob?.job_title?.S || '',
                    description: updatedJob?.description?.S || '',
                    requirements: updatedJob?.requirements?.SS || [],
                    date: updatedJob?.date?.S || '',
                    startTime: updatedJob?.start_time?.S || '',
                    endTime: updatedJob?.end_time?.S || '',
                    hourlyRate: updatedJob?.hourly_rate?.N ? parseFloat(updatedJob.hourly_rate.N) : 0,
                    mealBreak: updatedJob?.meal_break?.BOOL || false,
                    status: updatedJob?.status?.S || 'active',
                    updatedAt: updatedJob?.updated_at?.S || ''
                }
            })
        };
    }
    catch (error) {
        console.error("Error updating temporary job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to update temporary job. Please try again.",
                details: error.message
            })
        };
    }
};
exports.handler = handler;
