"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const aws_sdk_1 = require("aws-sdk");
const utils_1 = require("./utils");

const dynamodb = new aws_sdk_1.DynamoDB.DocumentClient();
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE;

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

const handler = async (event) => {
    try {
        // Verify JWT token and get user info
        const userInfo = await (0, utils_1.verifyToken)(event);
        if (!userInfo) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized - Invalid or expired token' })
            };
        }

        const userSub = userInfo.sub;

        // Query user addresses from DynamoDB
        const params = {
            TableName: USER_ADDRESSES_TABLE,
            KeyConditionExpression: 'userSub = :userSub',
            ExpressionAttributeValues: {
                ':userSub': userSub
            }
        };

        const result = await dynamodb.query(params).promise();

        if (!result.Items || result.Items.length === 0) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No addresses found for this user' })
            };
        }

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'User addresses retrieved successfully',
                addresses: result.Items,
                totalCount: result.Items.length
            })
        };
    }
    catch (error) {
        console.error('Error retrieving user addresses:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Failed to retrieve user addresses' })
        };
    }
};
exports.handler = handler;
