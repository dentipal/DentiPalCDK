"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const aws_sdk_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new aws_sdk_1.DynamoDBClient({ region: process.env.REGION });

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

const handler = async (event) => {
    try {
        // Step 1: Get userSub from JWT token
        const userSub = await (0, utils_1.validateToken)(event);

        // Step 2: Check if userSub is valid
        if (!userSub) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Unauthorized - Invalid or expired token" })
            };
        }

        // Step 3: Check if the user has a profile
        const getParams = {
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: userSub }
            }
        };
        const existingProfile = await dynamodb.send(new aws_sdk_1.GetItemCommand(getParams));

        if (!existingProfile.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Professional profile not found" })
            };
        }

        // Step 4: Check if the profile is the default profile
        if (existingProfile.Item.isDefault === true) {
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Cannot delete default profile. Set another profile as default first.'
                })
            };
        }

        // Step 5: Delete the professional profile
        const deleteParams = {
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: userSub }
            }
        };
        await dynamodb.send(new aws_sdk_1.DeleteItemCommand(deleteParams));

        // Step 6: Return success response
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Professional profile deleted successfully",
                userSub,
                deletedAt: new Date().toISOString()
            })
        };
    } catch (error) {
        console.error("Error deleting professional profile:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.handler = handler;
