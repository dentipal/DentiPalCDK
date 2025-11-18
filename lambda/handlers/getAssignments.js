"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        const userSub = event.requestContext.authorizer.claims.sub;
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        const { userSub: queryUserSub } = JSON.parse(event.body) || {};
        const targetUserSub = (0, utils_1.isRoot)(groups) && queryUserSub ? queryUserSub : userSub;
        const command = new client_dynamodb_1.QueryCommand({
            TableName: process.env.USER_CLINIC_ASSIGNMENTS_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: { ":userSub": { S: targetUserSub } },
        });
        const response = await dynamoClient.send(command);
        const assignments = (response.Items || []).map(item => ({
            userSub: item.userSub.S,
            clinicId: item.clinicId.S,
            accessLevel: item.accessLevel.S,
            assignedAt: item.assignedAt.S,
        }));
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", assignments }),
        };
    }
    catch (error) {
        console.error("Error retrieving assignments:", error);
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to retrieve assignments: ${error.message}` }) };
    }
};
exports.handler = handler;
