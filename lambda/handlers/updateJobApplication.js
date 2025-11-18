"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        const userSub = (0, utils_1.validateToken)(event);
        const updateData = JSON.parse(event.body);
        // Validate required fields
        if (!updateData.applicationId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Required field: applicationId"
                })
            };
        }
        // First, find the application by scanning (since we only have applicationId)
        const findApplicationCommand = new client_dynamodb_1.QueryCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            IndexName: 'ApplicationIndex', // Assuming we have a GSI on applicationId
            KeyConditionExpression: "applicationId = :applicationId",
            ExpressionAttributeValues: {
                ":applicationId": { S: updateData.applicationId }
            }
        });
        let applicationFound = null;
        try {
            const findResponse = await dynamodb.send(findApplicationCommand);
            if (findResponse.Items && findResponse.Items.length > 0) {
                applicationFound = findResponse.Items[0];
            }
        }
        catch (gsiError) {
            // If GSI doesn't exist, we'll need to scan the table
            console.warn("GSI not available, scanning table:", gsiError);
            const scanCommand = new client_dynamodb_1.ScanCommand({
                TableName: process.env.JOB_APPLICATIONS_TABLE,
                FilterExpression: "applicationId = :applicationId",
                ExpressionAttributeValues: {
                    ":applicationId": { S: updateData.applicationId }
                }
            });
            const scanResponse = await dynamodb.send(scanCommand);
            if (scanResponse.Items && scanResponse.Items.length > 0) {
                applicationFound = scanResponse.Items[0];
            }
        }
        if (!applicationFound) {
            return {
                statusCode: 404,
                body: JSON.stringify({
                    error: "Job application not found"
                })
            };
        }
        // Verify the application belongs to the authenticated user
        if (applicationFound.professionalUserSub?.S !== userSub) {
            return {
                statusCode: 403,
                body: JSON.stringify({
                    error: "You can only update your own job applications"
                })
            };
        }
        // Check if application can be updated (not accepted/declined)
        const currentStatus = applicationFound.applicationStatus?.S || 'pending';
        if (currentStatus === 'accepted' || currentStatus === 'declined') {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: `Cannot update application with status: ${currentStatus}`
                })
            };
        }
        // Build update expression
        const updateExpressions = [];
        const attributeNames = {};
        const attributeValues = {};
        if (updateData.message !== undefined) {
            updateExpressions.push("#msg = :msg");
            attributeNames["#msg"] = "applicationMessage";
            attributeValues[":msg"] = { S: updateData.message };
        }
        if (updateData.proposedRate !== undefined) {
            updateExpressions.push("proposedRate = :rate");
            attributeValues[":rate"] = { N: updateData.proposedRate.toString() };
        }
        if (updateData.availability !== undefined) {
            updateExpressions.push("availability = :avail");
            attributeValues[":avail"] = { S: updateData.availability };
        }
        if (updateData.startDate !== undefined) {
            updateExpressions.push("startDate = :start");
            attributeValues[":start"] = { S: updateData.startDate };
        }
        if (updateData.notes !== undefined) {
            updateExpressions.push("notes = :notes");
            attributeValues[":notes"] = { S: updateData.notes };
        }
        // Always update the updatedAt timestamp
        updateExpressions.push("updatedAt = :updated");
        attributeValues[":updated"] = { S: new Date().toISOString() };
        if (updateExpressions.length === 1) { // Only updatedAt
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "No fields to update. Provide at least one field: message, proposedRate, availability, startDate, notes"
                })
            };
        }
        // Update the application
        const jobId = applicationFound.jobId?.S;
        if (!jobId) {
            return {
                statusCode: 400,
                body: JSON.stringify({
                    error: "Invalid application data: missing jobId"
                })
            };
        }
        const updateCommand = new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: userSub }
            },
            UpdateExpression: `SET ${updateExpressions.join(', ')}`,
            ExpressionAttributeNames: Object.keys(attributeNames).length > 0 ? attributeNames : undefined,
            ExpressionAttributeValues: attributeValues,
            ReturnValues: "ALL_NEW"
        });
        const updateResponse = await dynamodb.send(updateCommand);
        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Job application updated successfully",
                applicationId: updateData.applicationId,
                updatedFields: Object.keys(updateData).filter(key => key !== 'applicationId'),
                updatedAt: attributeValues[":updated"].S
            })
        };
    }
    catch (error) {
        console.error("Error updating job application:", error);
        return {
            statusCode: 500,
            body: JSON.stringify({
                error: "Failed to update job application. Please try again.",
                details: error.message
            })
        };
    }
};
exports.handler = handler;
