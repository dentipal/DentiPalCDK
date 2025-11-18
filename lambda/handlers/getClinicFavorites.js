"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

/* === CORS Headers === */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // Replace with your frontend origin in production
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,x-api-key",
  "Access-Control-Allow-Credentials": "true",
  "Content-Type": "application/json",
};

const handler = async (event) => {
    /* Preflight */
    if (event && event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        const userSub = await (0, utils_1.validateToken)(event); // This should be a clinic user

        // Get query parameters
        const queryParams = event.queryStringParameters || {};
        const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
        const role = queryParams.role; // Optional filter by professional role
        const tags = queryParams.tags ? queryParams.tags.split(',') : null; // Optional filter by tags

        // Query clinic's favorites
        const queryCommand = new client_dynamodb_1.QueryCommand({
            TableName: process.env.CLINIC_FAVORITES_TABLE,
            KeyConditionExpression: 'clinicUserSub = :clinicUserSub',
            ExpressionAttributeValues: {
                ':clinicUserSub': { S: userSub }
            },
            Limit: limit,
            ScanIndexForward: false, // Most recent first
        });
        const favoritesResult = await dynamodb.send(queryCommand);

        if (!favoritesResult.Items || favoritesResult.Items.length === 0) {
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    message: "No favorites found",
                    favorites: [],
                    count: 0
                })
            };
        }

        // Get professional profile details for each favorite
        const professionalUserSubs = favoritesResult.Items.map(item => ({
            userSub: item.professionalUserSub.S
        }));

        // Batch get professional profiles
        const profileRequestItems = {};
        profileRequestItems[process.env.PROFESSIONAL_PROFILES_TABLE] = {
            Keys: professionalUserSubs.map(prof => ({
                userSub: { S: prof.userSub }
            }))
        };
        const profilesResult = await dynamodb.send(new client_dynamodb_1.BatchGetItemCommand({
            RequestItems: profileRequestItems
        }));
        const profiles = profilesResult.Responses?.[process.env.PROFESSIONAL_PROFILES_TABLE] || [];

        // Batch get addresses from USER_ADDRESSES_TABLE
        const addressRequestItems = {};
        addressRequestItems[process.env.USER_ADDRESSES_TABLE] = {
            Keys: professionalUserSubs.map(prof => ({
                userSub: { S: prof.userSub }
            }))
        };
        const addressesResult = await dynamodb.send(new client_dynamodb_1.BatchGetItemCommand({
            RequestItems: addressRequestItems
        }));
        const addresses = addressesResult.Responses?.[process.env.USER_ADDRESSES_TABLE] || [];

        // Combine favorites with professional details and addresses
        const favoritesWithDetails = favoritesResult.Items.map(favorite => {
            const professionalProfile = profiles.find(profile => profile.userSub.S === favorite.professionalUserSub.S);
            const address = addresses.find(addr => addr.userSub.S === favorite.professionalUserSub.S);
            const favoriteData = {
                professionalUserSub: favorite.professionalUserSub.S,
                addedAt: favorite.addedAt.S,
                updatedAt: favorite.updatedAt.S,
                notes: favorite.notes?.S || null,
                tags: favorite.tags?.SS || [],
                professional: professionalProfile ? {
                    userSub: professionalProfile.userSub.S,
                    first_name: professionalProfile.first_name?.S || 'Unknown',
                    last_name: professionalProfile.last_name?.S || 'Unknown',
                    role: professionalProfile.role?.S || 'Unknown',
                    city: address?.city?.S || 'N/A', // Add city from USER_ADDRESSES_TABLE
                    profile_image: professionalProfile.profile_image?.S || null,
                    years_of_experience: professionalProfile.years_of_experience?.N ?
                        parseInt(professionalProfile.years_of_experience.N) : null,
                    dental_software_experience: professionalProfile.dental_software_experience?.SS || [],
                    languages_known: professionalProfile.languages_known?.SS || [],
                    has_dental_office_experience: professionalProfile.has_dental_office_experience?.BOOL || false,
                    createdAt: professionalProfile.createdAt?.S
                } : null
            };
            return favoriteData;
        });

        // Apply filters
        let filteredFavorites = favoritesWithDetails;

        // Filter by professional role if specified
        if (role) {
            filteredFavorites = filteredFavorites.filter(fav => fav.professional?.role === role);
        }

        // Filter by tags if specified
        if (tags && tags.length > 0) {
            filteredFavorites = filteredFavorites.filter(fav => tags.some((tag) => fav.tags.includes(tag)));
        }

        // Group by role for summary
        const roleStats = filteredFavorites.reduce((acc, fav) => {
            const role = fav.professional?.role || 'Unknown';
            acc[role] = (acc[role] || 0) + 1;
            return acc;
        }, {});

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: "Favorites retrieved successfully",
                favorites: filteredFavorites,
                count: filteredFavorites.length,
                totalFavorites: favoritesResult.Items.length,
                roleDistribution: roleStats,
                filters: {
                    role: role || null,
                    tags: tags || null
                }
            })
        };
    }
    catch (error) {
        console.error("Error getting clinic favorites:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: error.message })
        };
    }
};
exports.handler = handler;