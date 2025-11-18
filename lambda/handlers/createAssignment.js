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
            return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can assign clinics" }) };
        }
        const { userSub, clinicId, accessLevel } = JSON.parse(event.body);
        if (!userSub || !clinicId || !accessLevel) {
            return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields" }) };
        }
        const validAccessLevels = ['ClinicAdmin', 'ClinicManager', 'ClinicViewer', 'Professional'];
        if (!validAccessLevels.includes(accessLevel)) {
            return { statusCode: 400, body: JSON.stringify({ error: "Invalid access level" }) };
        }
        const command = new client_dynamodb_1.PutItemCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
            Item: {
                userSub: { S: userSub },
                clinicId: { S: clinicId },
                accessLevel: { S: accessLevel },
                assignedAt: { S: new Date().toISOString() },
            },
        });
        await dynamoClient.send(command);
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "User assigned to clinic successfully" }),
        };
    }
    catch (error) {
        console.error("Error assigning user to clinic:", error);
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to assign user: ${error.message}` }) };
    }
};
exports.handler = handler;
