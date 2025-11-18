"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const VALID_STATUS_TRANSITIONS = {
    'open': ['scheduled', 'action_needed', 'completed'],
    'scheduled': ['action_needed', 'completed', 'open'], // Can reopen if needed
    'action_needed': ['scheduled', 'completed', 'open'], // Can resolve negotiation
    'completed': ['open'] // Can reopen if necessary
};
const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user
        const jobId = event.pathParameters?.jobId;
        const statusData = JSON.parse(event.body);
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "jobId is required in path"
                })
            };
        }
        if (!statusData.status) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "status is required"
                })
            };
        }
        const validStatuses = ['open', 'scheduled', 'action_needed', 'completed'];
        if (!validStatuses.includes(statusData.status)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Invalid status. Valid options: ${validStatuses.join(', ')}`
                })
            };
        }
        // Get current job to verify ownership and current status
        const currentJob = await dynamodb.send(new client_dynamodb_1.GetItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            }
        }));
        if (!currentJob.Item) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Job not found or you don't have permission to update it"
                })
            };
        }
        const currentStatus = currentJob.Item.status?.S || 'open';
        // Validate status transition
        if (!VALID_STATUS_TRANSITIONS[currentStatus]?.includes(statusData.status)) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Cannot transition from ${currentStatus} to ${statusData.status}`
                })
            };
        }
        // Validate required fields for specific statuses
        if (statusData.status === 'scheduled' && !statusData.acceptedProfessionalUserSub) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "acceptedProfessionalUserSub is required for scheduled status"
                })
            };
        }
        if (statusData.status === 'scheduled' && !statusData.scheduledDate) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "scheduledDate is required for scheduled status"
                })
            };
        }
        const timestamp = new Date().toISOString();
        // Build update expression
        let updateExpression = 'SET #status = :status, #updatedAt = :updatedAt';
        const expressionAttributeNames = {
            '#status': 'status',
            '#updatedAt': 'updatedAt'
        };
        const expressionAttributeValues = {
            ':status': { S: statusData.status },
            ':updatedAt': { S: timestamp }
        };
        // Add optional fields based on status
        if (statusData.notes) {
            updateExpression += ', #notes = :notes';
            expressionAttributeNames['#notes'] = 'statusNotes';
            expressionAttributeValues[':notes'] = { S: statusData.notes };
        }
        if (statusData.acceptedProfessionalUserSub) {
            updateExpression += ', #acceptedProfessional = :acceptedProfessional';
            expressionAttributeNames['#acceptedProfessional'] = 'acceptedProfessionalUserSub';
            expressionAttributeValues[':acceptedProfessional'] = { S: statusData.acceptedProfessionalUserSub };
        }
        if (statusData.scheduledDate) {
            updateExpression += ', #scheduledDate = :scheduledDate';
            expressionAttributeNames['#scheduledDate'] = 'scheduledDate';
            expressionAttributeValues[':scheduledDate'] = { S: statusData.scheduledDate };
        }
        if (statusData.completionNotes && statusData.status === 'completed') {
            updateExpression += ', #completionNotes = :completionNotes, #completedAt = :completedAt';
            expressionAttributeNames['#completionNotes'] = 'completionNotes';
            expressionAttributeNames['#completedAt'] = 'completedAt';
            expressionAttributeValues[':completionNotes'] = { S: statusData.completionNotes };
            expressionAttributeValues[':completedAt'] = { S: timestamp };
        }
        // Add status history
        const statusHistory = currentJob.Item.statusHistory?.L || [];
        const newHistoryEntry = {
            M: {
                fromStatus: { S: currentStatus },
                toStatus: { S: statusData.status },
                changedAt: { S: timestamp },
                changedBy: { S: userSub },
                notes: { S: statusData.notes || '' }
            }
        };
        statusHistory.push(newHistoryEntry);
        updateExpression += ', #statusHistory = :statusHistory';
        expressionAttributeNames['#statusHistory'] = 'statusHistory';
        expressionAttributeValues[':statusHistory'] = { L: statusHistory };
        await dynamodb.send(new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                jobId: { S: jobId }
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues
        }));
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Job status updated successfully",
                jobId,
                previousStatus: currentStatus,
                newStatus: statusData.status,
                updatedAt: timestamp,
                acceptedProfessional: statusData.acceptedProfessionalUserSub || null,
                scheduledDate: statusData.scheduledDate || null
            })
        };
    }
    catch (error) {
        console.error("Error updating job status:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: error.message })
        };
    }
};
exports.handler = handler;
