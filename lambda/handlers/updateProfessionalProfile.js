"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const professionalRoles_1 = require("./professionalRoles");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

const handler = async (event) => {
    try {
        const userSub = await (0, utils_1.validateToken)(event);
        const updateData = JSON.parse(event.body);

        // Validate role if provided
        if (updateData.role && !professionalRoles_1.VALID_ROLE_VALUES.includes(updateData.role)) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: `Invalid role. Valid options: ${professionalRoles_1.VALID_ROLE_VALUES.map(
                        role => professionalRoles_1.DB_TO_DISPLAY_MAPPING[role]
                    ).join(', ')}`
                })
            };
        }

        // Check if profile exists
        const getCommand = new client_dynamodb_1.GetItemCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } }
        });
        const existingProfile = await dynamodb.send(getCommand);
        if (!existingProfile.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Professional profile not found" })
            };
        }

        // Build update expression
        const updateExpressions = [];
        const expressionAttributeValues = {};
        const expressionAttributeNames = {};

        // Always update the timestamp
        updateExpressions.push("#updatedAt = :updatedAt");
        expressionAttributeNames["#updatedAt"] = "updatedAt";
        expressionAttributeValues[":updatedAt"] = { S: new Date().toISOString() };

        // Handle all possible fields
        Object.entries(updateData).forEach(([key, value]) => {
            if (value !== undefined) {
                const attrKey = `:${key}`;
                const nameKey = `#${key}`;
                updateExpressions.push(`${nameKey} = ${attrKey}`);
                expressionAttributeNames[nameKey] = key;

                if (typeof value === 'string') {
                    expressionAttributeValues[attrKey] = { S: value };
                } else if (typeof value === 'boolean') {
                    expressionAttributeValues[attrKey] = { BOOL: value };
                } else if (typeof value === 'number') {
                    expressionAttributeValues[attrKey] = { N: value.toString() };
                } else if (Array.isArray(value)) {
                    expressionAttributeValues[attrKey] = { SS: value.length > 0 ? value : [''] };
                }
            }
        });

        if (updateExpressions.length === 1) { // Only timestamp
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "No fields to update" })
            };
        }

        const updateCommand = new client_dynamodb_1.UpdateItemCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: `SET ${updateExpressions.join(", ")}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW"
        });

        const result = await dynamodb.send(updateCommand);

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Professional profile updated successfully",
                profile: {
                    userSub: result.Attributes?.userSub?.S,
                    role: result.Attributes?.role?.S,
                    full_name: result.Attributes?.full_name?.S,
                    updatedAt: result.Attributes?.updatedAt?.S
                }
            })
        };
    } catch (error) {
        console.error("Error updating professional profile:", error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({
                error: "Failed to update professional profile. Please try again.",
                details: error.message
            })
        };
    }
};
exports.handler = handler;
