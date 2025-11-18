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
        const requestBody = JSON.parse(event.body || '{}');
        const updateFields = requestBody;

        // Validate required fields
        if (Object.keys(updateFields).length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No valid fields provided for update' })
            };
        }

        // Check if the user has an existing address
        const getParams = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub }
        };
        const existingAddress = await dynamodb.get(getParams).promise();
        if (!existingAddress.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Address not found for this user' })
            };
        }

        // Validate update fields
        const allowedFields = [
            'addressLine1', 'addressLine2', 'city', 'state', 'pincode',
            'country', 'addressType', 'isDefault'
        ];
        const validUpdateFields = {};
        const updatedFields = [];
        for (const [key, value] of Object.entries(updateFields)) {
            if (allowedFields.includes(key)) {
                validUpdateFields[key] = value;
                updatedFields.push(key);
            }
        }

        if (updatedFields.length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No valid fields provided for update' })
            };
        }

        // Build update expression
        const updateExpression =
            'SET ' + updatedFields.map(field => `#${field} = :${field}`).join(', ');
        const expressionAttributeNames = {};
        const expressionAttributeValues = {};
        updatedFields.forEach(field => {
            expressionAttributeNames[`#${field}`] = field;
            expressionAttributeValues[`:${field}`] = validUpdateFields[field];
        });
        expressionAttributeNames['#updatedAt'] = 'updatedAt';
        expressionAttributeValues[':updatedAt'] = new Date().toISOString();

        const updateParams = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub },
            UpdateExpression: updateExpression + ', #updatedAt = :updatedAt',
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await dynamodb.update(updateParams).promise();

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Address updated successfully',
                updatedFields,
                updatedAt: new Date().toISOString(),
                address: result.Attributes
            })
        };
    } catch (error) {
        console.error('Error updating user address:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Failed to update user address' })
        };
    }
};

exports.handler = handler;
