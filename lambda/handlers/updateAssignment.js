"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        if (!(0, utils_1.isRoot)(groups)) {
            return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can update assignments" }) };
        }
        const { userSub, clinicId, accessLevel } = JSON.parse(event.body);
        if (!userSub || !clinicId || !accessLevel) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }
        const validAccessLevels = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
        if (!validAccessLevels.includes(accessLevel)) {
            return { statusCode: 400, body: JSON.stringify({ error: "Invalid access level" }) };
        }
        const command = new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
            Key: { userSub: { S: userSub }, clinicId: { S: clinicId } },
            UpdateExpression: "SET accessLevel = :accessLevel, assignedAt = :assignedAt",
            ExpressionAttributeValues: {
                ":accessLevel": { S: accessLevel },
                ":assignedAt": { S: new Date().toISOString() },
            },
        });
        await dynamoClient.send(command);
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "Assignment updated successfully" }),
        };
    }
    catch (error) {
        console.error("Error updating assignment:", error);
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to update assignment: ${error.message}` }) };
    }
};
exports.handler = handler;
