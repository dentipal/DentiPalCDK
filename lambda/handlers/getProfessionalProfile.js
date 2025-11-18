"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGI || "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS"
};

const handler = async (event) => {
    try {
        // Handle preflight
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders, body: "" };
        }

        const userSub = await (0, utils_1.validateToken)(event);
        const { profileId } = event.queryStringParameters || {};
        let command;
        if (profileId) {
            // Get specific profile
            command = new client_dynamodb_1.QueryCommand({
                TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                KeyConditionExpression: "userSub = :userSub AND profileId = :profileId",
                ExpressionAttributeValues: {
                    ":userSub": { S: userSub },
                    ":profileId": { S: profileId }
                }
            });
        } else {
            // Get all profiles for the user
            command = new client_dynamodb_1.QueryCommand({
                TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
                KeyConditionExpression: "userSub = :userSub",
                ExpressionAttributeValues: {
                    ":userSub": { S: userSub }
                }
            });
        }

        const result = await dynamodb.send(command);

        // Convert DynamoDB items to regular objects
        const profiles = result.Items?.map(item => {
            const profile = {};
            Object.entries(item).forEach(([key, value]) => {
                if (value.S) profile[key] = value.S;
                else if (value.N) profile[key] = Number(value.N);
                else if (value.BOOL !== undefined) profile[key] = value.BOOL;
                else if (value.SS) profile[key] = value.SS;
            });
            return profile;
        }) || [];

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                profiles: profileId ? profiles[0] || null : profiles,
                count: profiles.length
            })
        };
    } catch (error) {
        console.error("Error getting professional profile:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: error.message })
        };
    }
};
exports.handler = handler;
