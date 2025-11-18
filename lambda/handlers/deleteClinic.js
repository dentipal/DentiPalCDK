"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });
const handler = async (event) => {
    try {
        const userSub = (0, utils_1.validateToken)(event);
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        let  clinicId = event.pathParameters?.clinicId || event.pathParameters?.proxy;
        console.log("Extracted clinicId:", clinicId);
        if (!clinicId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required in path parameters" }) };
        }
        // Only Root users can delete clinics
        if (!(0, utils_1.isRoot)(groups)) {
            return { statusCode: 403, body: JSON.stringify({ error: "Only Root users can delete clinics" }) };
        }
        const command = new client_dynamodb_1.DeleteItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        });
        await dynamoClient.send(command);
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "Clinic deleted successfully" }),
        };
    }
    catch (error) {
        console.error("Error deleting clinic:", error);
        return { statusCode: 400, body: JSON.stringify({ error: `Failed to delete clinic: ${error.message}` }) };
    }
};
exports.handler = handler;
