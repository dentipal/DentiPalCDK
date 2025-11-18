"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        const userSub = (0, utils_1.validateToken)(event);

        // Extract jobId from the proxy path
        const pathParts = event.pathParameters?.proxy?.split('/'); // Split the path by '/'
        const jobId = pathParts?.[2]; // jobId will be the third part (index 2)

        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path parameters"
                })
            };
        }

        // Get the permanent job
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
                    error: "Permanent job not found or access denied"
                })
            };
        }
        const existingJob = jobResponse.Item;

        // Verify it's a permanent job
        if (existingJob.job_type?.S !== 'permanent') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "This is not a permanent job. Use the appropriate endpoint for this job type."
                })
            };
        }

        // Parse update data from the request body
        const updateData = JSON.parse(event.body);

        // Build update expression for job-related fields
        const updateExpressions = [];
        const attributeNames = {};
        const attributeValues = {};

        // Always update the timestamp
        updateExpressions.push("#updatedAt = :updatedAt");
        attributeNames["#updatedAt"] = "updated_at";
        attributeValues[":updatedAt"] = { S: new Date().toISOString() };

        // Handle job-related fields
        if (updateData.professional_role !== undefined) {
            updateExpressions.push("#professionalRole = :professionalRole");
            attributeNames["#professionalRole"] = "professional_role";
            attributeValues[":professionalRole"] = { S: updateData.professional_role };
        }
        if (updateData.shift_speciality !== undefined) {
            updateExpressions.push("#shiftSpeciality = :shiftSpeciality");
            attributeNames["#shiftSpeciality"] = "shift_speciality";
            attributeValues[":shiftSpeciality"] = { S: updateData.shift_speciality };
        }
        if (updateData.employment_type !== undefined) {
            updateExpressions.push("#employmentType = :employmentType");
            attributeNames["#employmentType"] = "employment_type";
            attributeValues[":employmentType"] = { S: updateData.employment_type };
        }
        if (updateData.salary_min !== undefined) {
            updateExpressions.push("#salaryMin = :salaryMin");
            attributeNames["#salaryMin"] = "salary_min";
            attributeValues[":salaryMin"] = { N: updateData.salary_min.toString() };
        }
        if (updateData.salary_max !== undefined) {
            updateExpressions.push("#salaryMax = :salaryMax");
            attributeNames["#salaryMax"] = "salary_max";
            attributeValues[":salaryMax"] = { N: updateData.salary_max.toString() };
        }
        if (updateData.benefits !== undefined) {
            updateExpressions.push("#benefits = :benefits");
            attributeNames["#benefits"] = "benefits";
            attributeValues[":benefits"] = { SS: updateData.benefits };
        }
        if (updateData.vacation_days !== undefined) {
            updateExpressions.push("#vacationDays = :vacationDays");
            attributeNames["#vacationDays"] = "vacation_days";
            attributeValues[":vacationDays"] = { N: updateData.vacation_days.toString() };
        }
        if (updateData.work_schedule !== undefined) {
            updateExpressions.push("#workSchedule = :workSchedule");
            attributeNames["#workSchedule"] = "work_schedule";
            attributeValues[":workSchedule"] = { S: updateData.work_schedule };
        }
        if (updateData.start_date !== undefined) {
            updateExpressions.push("#startDate = :startDate");
            attributeNames["#startDate"] = "start_date";
            attributeValues[":startDate"] = { S: updateData.start_date };
        }
        if (updateData.job_title !== undefined) {
            updateExpressions.push("#jobTitle = :jobTitle");
            attributeNames["#jobTitle"] = "job_title";
            attributeValues[":jobTitle"] = { S: updateData.job_title };
        }
        if (updateData.job_description !== undefined) {
            updateExpressions.push("#jobDescription = :jobDescription");
            attributeNames["#jobDescription"] = "job_description";
            attributeValues[":jobDescription"] = { S: updateData.job_description };
        }
        if (updateData.requirements !== undefined) {
            updateExpressions.push("#requirements = :requirements");
            attributeNames["#requirements"] = "requirements";
            attributeValues[":requirements"] = { SS: updateData.requirements };
        }

        // Update the job in DynamoDB
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
                message: "Permanent job updated successfully",
                job: {
                    jobId: updatedJob?.jobId?.S || '',
                    jobType: updatedJob?.job_type?.S || '',
                    professionalRole: updatedJob?.professional_role?.S || '',
                    jobTitle: updatedJob?.job_title?.S || '',
                    shiftSpeciality: updatedJob?.shift_speciality?.S || '',
                    employmentType: updatedJob?.employment_type?.S || '',
                    salaryMin: updatedJob?.salary_min?.N ? parseFloat(updatedJob.salary_min.N) : 0,
                    salaryMax: updatedJob?.salary_max?.N ? parseFloat(updatedJob.salary_max.N) : 0,
                    benefits: updatedJob?.benefits?.SS || [],
                    vacationDays: updatedJob?.vacation_days?.N ? parseInt(updatedJob.vacation_days.N) : 0,
                    workSchedule: updatedJob?.work_schedule?.S || '',
                    startDate: updatedJob?.start_date?.S || '',
                    jobDescription: updatedJob?.job_description?.S || '',
                    requirements: updatedJob?.requirements?.SS || []
                }
            })
        };

    } catch (error) {
        console.error("Error updating permanent job:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to update permanent job. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;
