"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

/* === CORS (added) === */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // replace with your origin in prod
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

const handler = async (event) => {
    /* Preflight (added) */
    if (event && event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Debug: log the entire event to check the structure
        console.log('Received event:', JSON.stringify(event, null, 2));

        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user
        
        // Debug: log pathParameters to see the structure
        console.log('pathParameters:', JSON.stringify(event.pathParameters, null, 2));

        // Get professionalUserSub from the proxy path
        const fullPath = event.pathParameters?.proxy || '';  // Use proxy from path parameters
        const pathParts = fullPath.split('/');
        
        // Extract professionalUserSub from the last part of the path
        const professionalUserSub = pathParts[pathParts.length - 1];

        if (!professionalUserSub) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // added
                body: JSON.stringify({
                    error: "professionalUserSub is required in the path"
                })
            };
        }

        // Check if favorite exists
        const existingFavorite = await dynamodb.send(new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                professionalUserSub: { S: professionalUserSub }
            }
        }));

        if (!existingFavorite.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, // added
                body: JSON.stringify({
                    error: "Professional not found in favorites"
                })
            };
        }

        // Delete the favorite
        await dynamodb.send(new client_dynamodb_1.DeleteItemCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                professionalUserSub: { S: professionalUserSub }
            }
        }));

        return {
            statusCode: 200,
            headers: CORS_HEADERS, // added
            body: JSON.stringify({
                message: "Professional removed from favorites successfully",
                clinicUserSub: userSub,
                professionalUserSub: professionalUserSub,
                removedAt: new Date().toISOString()
            })
        };
    } catch (error) {
        console.error("Error removing professional from favorites:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // added
            body: JSON.stringify({ error: error.message })
        };
    }
};
exports.handler = handler;
