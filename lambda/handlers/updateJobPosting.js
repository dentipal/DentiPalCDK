"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const professionalRoles_1 = require("./professionalRoles");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        // Get user information from the event
        const userSub = event.requestContext.authorizer?.claims?.sub;
        if (!userSub) {
            return {
                statusCode: 401,
                body: JSON.stringify({ error: 'Unauthorized' })
            };
        }
        if (event.httpMethod !== 'PUT') {
            return {
                statusCode: 405,
                body: JSON.stringify({ error: 'Method not allowed' })
            };
        }
        // Extract job ID from path parameters
        const jobId = event.pathParameters?.jobId;
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Job ID is required' })
            };
        }
        if (!event.body) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Request body is required' })
            };
        }
        const updateData = JSON.parse(event.body);
        // Get existing job to verify ownership and job type
        const getCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            }
        });
        const existingJob = await dynamodb.send(getCommand);
        if (!existingJob.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({ error: 'Job not found' })
            };
        }
        const clinicUserSub = existingJob.Item.clinicUserSub.S;
        const jobType = existingJob.Item.job_type.S;
        const currentStatus = existingJob.Item.status?.S || 'open';
        // Security check: Only clinic owner can update their jobs
        if (userSub !== clinicUserSub) {
            return {
                statusCode: 403,
                body: JSON.stringify({ error: 'Access denied - you can only update your own jobs' })
            };
        }
        // Prevent updates to completed jobs
        if (currentStatus === 'completed') {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Cannot update completed jobs' })
            };
        }
        // Validate professional role if provided
        if (updateData.professional_role && !professionalRoles_1.VALID_ROLE_VALUES.includes(updateData.professional_role)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid professional_role. Valid options: ${professionalRoles_1.VALID_ROLE_VALUES.join(', ')}`
                })
            };
        }
        // Validate job type specific fields
        if (jobType === 'temporary') {
            if (updateData.date) {
                const jobDate = new Date(updateData.date);
                if (jobDate <= new Date()) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Job date must be in the future' })
                    };
                }
            }
            if (updateData.hours && (updateData.hours < 1 || updateData.hours > 12)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Hours must be between 1 and 12' })
                };
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 200)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Hourly rate must be between $10 and $200' })
                };
            }
        }
        else if (jobType === 'multi_day_consulting') {
            if (updateData.dates) {
                if (updateData.dates.length === 0 || updateData.dates.length > 30) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({ error: 'Dates array must have 1-30 entries' })
                    };
                }
                // Validate all dates are in the future
                const invalidDates = updateData.dates.filter(date => new Date(date) <= new Date());
                if (invalidDates.length > 0) {
                    return {
                        statusCode: 400,
                        body: JSON.stringify({ error: 'All dates must be in the future' })
                    };
                }
                updateData.total_days = updateData.dates.length;
            }
            if (updateData.hours_per_day && (updateData.hours_per_day < 1 || updateData.hours_per_day > 12)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Hours per day must be between 1 and 12' })
                };
            }
            if (updateData.hourly_rate && (updateData.hourly_rate < 10 || updateData.hourly_rate > 300)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Hourly rate must be between $10 and $300' })
                };
            }
        }
        else if (jobType === 'permanent') {
            if (updateData.salary_min && (updateData.salary_min < 20000 || updateData.salary_min > 500000)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Minimum salary must be between $20,000 and $500,000' })
                };
            }
            if (updateData.salary_max && updateData.salary_min && updateData.salary_max <= updateData.salary_min) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Maximum salary must be greater than minimum salary' })
                };
            }
            if (updateData.vacation_days && (updateData.vacation_days < 0 || updateData.vacation_days > 50)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Vacation days must be between 0 and 50' })
                };
            }
            if (updateData.employment_type && !['full_time', 'part_time'].includes(updateData.employment_type)) {
                return {
                    statusCode: 400,
                    body: JSON.stringify({ error: 'Employment type must be full_time or part_time' })
                };
            }
        }
        // Build update expression
        const updateExpressions = [];
        const expressionAttributeNames = {};
        const expressionAttributeValues = {};
        // Common fields that can be updated for all job types
        if (updateData.professional_role !== undefined) {
            updateExpressions.push('#pr = :pr');
            expressionAttributeNames['#pr'] = 'professional_role';
            expressionAttributeValues[':pr'] = { S: updateData.professional_role };
        }
        if (updateData.shift_speciality !== undefined) {
            updateExpressions.push('shift_speciality = :ss');
            expressionAttributeValues[':ss'] = { S: updateData.shift_speciality };
        }
        if (updateData.assisted_hygiene !== undefined) {
            updateExpressions.push('assisted_hygiene = :ah');
            expressionAttributeValues[':ah'] = { BOOL: updateData.assisted_hygiene };
        }
        if (updateData.meal_break !== undefined) {
            updateExpressions.push('meal_break = :mb');
            expressionAttributeValues[':mb'] = { BOOL: updateData.meal_break };
        }
        // Job type specific fields
        if (jobType === 'temporary') {
            if (updateData.date !== undefined) {
                updateExpressions.push('#d = :d');
                expressionAttributeNames['#d'] = 'date';
                expressionAttributeValues[':d'] = { S: updateData.date };
            }
            if (updateData.hours !== undefined) {
                updateExpressions.push('#h = :h');
                expressionAttributeNames['#h'] = 'hours';
                expressionAttributeValues[':h'] = { N: updateData.hours.toString() };
            }
            if (updateData.hourly_rate !== undefined) {
                updateExpressions.push('hourly_rate = :hr');
                expressionAttributeValues[':hr'] = { N: updateData.hourly_rate.toString() };
            }
        }
        else if (jobType === 'multi_day_consulting') {
            if (updateData.dates !== undefined) {
                updateExpressions.push('dates = :dates');
                expressionAttributeValues[':dates'] = { SS: updateData.dates };
            }
            if (updateData.total_days !== undefined) {
                updateExpressions.push('total_days = :td');
                expressionAttributeValues[':td'] = { N: updateData.total_days.toString() };
            }
            if (updateData.hours_per_day !== undefined) {
                updateExpressions.push('hours_per_day = :hpd');
                expressionAttributeValues[':hpd'] = { N: updateData.hours_per_day.toString() };
            }
            if (updateData.hourly_rate !== undefined) {
                updateExpressions.push('hourly_rate = :hr');
                expressionAttributeValues[':hr'] = { N: updateData.hourly_rate.toString() };
            }
            if (updateData.project_duration !== undefined) {
                updateExpressions.push('project_duration = :pd');
                expressionAttributeValues[':pd'] = { S: updateData.project_duration };
            }
        }
        else if (jobType === 'permanent') {
            if (updateData.employment_type !== undefined) {
                updateExpressions.push('employment_type = :et');
                expressionAttributeValues[':et'] = { S: updateData.employment_type };
            }
            if (updateData.salary_min !== undefined) {
                updateExpressions.push('salary_min = :smin');
                expressionAttributeValues[':smin'] = { N: updateData.salary_min.toString() };
            }
            if (updateData.salary_max !== undefined) {
                updateExpressions.push('salary_max = :smax');
                expressionAttributeValues[':smax'] = { N: updateData.salary_max.toString() };
            }
            if (updateData.benefits !== undefined) {
                updateExpressions.push('benefits = :benefits');
                expressionAttributeValues[':benefits'] = { SS: updateData.benefits };
            }
            if (updateData.vacation_days !== undefined) {
                updateExpressions.push('vacation_days = :vd');
                expressionAttributeValues[':vd'] = { N: updateData.vacation_days.toString() };
            }
            if (updateData.work_schedule !== undefined) {
                updateExpressions.push('work_schedule = :ws');
                expressionAttributeValues[':ws'] = { S: updateData.work_schedule };
            }
            if (updateData.start_date !== undefined) {
                updateExpressions.push('start_date = :sd');
                expressionAttributeValues[':sd'] = { S: updateData.start_date };
            }
        }
        if (updateExpressions.length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'No valid fields to update' })
            };
        }
        // Add updated timestamp
        updateExpressions.push('updated_at = :updated_at');
        expressionAttributeValues[':updated_at'] = { S: new Date().toISOString() };
        // Update the job
        const updateCommand = new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                jobId: { S: jobId }
            },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        });
        const result = await dynamodb.send(updateCommand);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: 'Job updated successfully',
                jobId,
                updatedAt: new Date().toISOString(),
                fieldsUpdated: Object.keys(updateData),
                updatedJob: result.Attributes
            })
        };
    }
    catch (error) {
        console.error('Error updating job posting:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Internal server error' })
        };
    }
};
exports.handler = handler;
