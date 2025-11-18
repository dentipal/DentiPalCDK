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
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user
        const favoriteData = JSON.parse(event.body);

        // Validate required fields
        if (!favoriteData.professionalUserSub) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // added
                body: JSON.stringify({
                    error: "Required field: professionalUserSub"
                })
            };
        }

        // Check if professional exists by looking up their profile
        const professionalCheck = await dynamodb.send(new client_dynamodb_1.GetItemCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
            Key: {
                userSub: { S: favoriteData.professionalUserSub }
            }
        }));
        if (!professionalCheck.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, // added
                body: JSON.stringify({
                    error: "Professional not found"
                })
            };
        }

        // Check if already in favorites
        const existingFavorite = await dynamodb.send(new client_dynamodb_1.GetItemCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Key: {
                clinicUserSub: { S: userSub },
                professionalUserSub: { S: favoriteData.professionalUserSub }
            }
        }));
        if (existingFavorite.Item) {
            return {
                statusCode: 409,
                headers: CORS_HEADERS, // added
                body: JSON.stringify({
                    error: "Professional is already in favorites"
                })
            };
        }

        const timestamp = new Date().toISOString();

        // Build DynamoDB item
        const item = {
            clinicUserSub: { S: userSub },
            professionalUserSub: { S: favoriteData.professionalUserSub },
            addedAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };
        // Add optional fields
        if (favoriteData.notes) {
            item.notes = { S: favoriteData.notes };
        }
        if (favoriteData.tags && favoriteData.tags.length > 0) {
            item.tags = { SS: favoriteData.tags };
        }

        await dynamodb.send(new client_dynamodb_1.PutItemCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            Item: item
        }));

        return {
            statusCode: 201,
            headers: CORS_HEADERS, // added
            body: JSON.stringify({
                message: "Professional added to favorites successfully",
                clinicUserSub: userSub,
                professionalUserSub: favoriteData.professionalUserSub,
                professionalName: professionalCheck.Item.full_name?.S || 'Unknown',
                professionalRole: professionalCheck.Item.role?.S || 'Unknown',
                addedAt: timestamp
            })
        };
    }
    catch (error) {
        console.error("Error adding professional to favorites:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // added
            body: JSON.stringify({ error: error.message })
        };
    }
};
exports.handler = handler;
