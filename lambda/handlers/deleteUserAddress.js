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

        // Fetch the user's addresses
        const getParams = {
            TableName: USER_ADDRESSES_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": userSub
            }
        };
        const existingAddresses = await dynamodb.query(getParams).promise();

        if (!existingAddresses.Items || existingAddresses.Items.length === 0) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No addresses found for this user' })
            };
        }

        // Check if the address is the default address
        const addressToDelete = existingAddresses.Items[0]; // Assuming you want to delete the first address
        if (addressToDelete.isDefault === true) {
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Cannot delete default address. Set another address as default first.'
                })
            };
        }

        // Delete the address (assuming only one address is associated with userSub)
        const deleteParams = {
            TableName: USER_ADDRESSES_TABLE,
            Key: {
                userSub: userSub,
                addressId: addressToDelete.addressId // Ensure addressId exists in your schema
            }
        };

        await dynamodb.delete(deleteParams).promise();

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Address deleted successfully',
                addressId: addressToDelete.addressId,
                deletedAt: new Date().toISOString()
            })
        };
    }
    catch (error) {
        console.error('Error deleting user address:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Failed to delete user address' })
        };
    }
};

exports.handler = handler;
