"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");

// Initialize DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    // Define CORS headers outside the try/catch for consistency
    const headers = {
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Allow-Origin": "*", // **IMPORTANT: Change '*' to your frontend URL in production**
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET"
    };

    if (event.httpMethod === 'OPTIONS') {
        // Respond to CORS preflight request
        return {
            statusCode: 204, // No Content
            headers: headers,
            body: ''
        };
    }

    try {
        const command = new ScanCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
        });

        const result = await dynamodb.send(command);

        const profiles = await Promise.all(result.Items?.map(async (item) => {
            const addressCommand = new QueryCommand({
                TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
                KeyConditionExpression: "userSub = :userSub",
                ExpressionAttributeValues: {
                    ":userSub": { S: item.userSub?.S || '' }
                }
            });

            const addressResult = await dynamodb.send(addressCommand);
            const address = addressResult.Items?.[0] || {};

            const city = address.city?.S || '';
            const state = address.state?.S || '';
            const zipcode = address.pincode?.S || '';

            return {
                userSub: item.userSub?.S || '',
                dentalSoftwareExperience: item.dental_software_experience?.SS || [],
                firstName: item.first_name?.S || item.full_name?.S || '',
                // Use lastName from item, or empty string if not available. No need for charAt(0).toUpperCase() unless that's a specific requirement.
                lastName: item.last_name?.S || '',
                role: item.role?.S || '',
                specialties: item.specialties?.SS || [],
                yearsOfExperience: item.years_of_experience?.N ? parseInt(item.years_of_experience.N) : 0,
                city: city,
                state: state,
                zipcode: zipcode
            };
        }) || []);

        return {
            statusCode: 200,
            headers: headers, // <-- Add headers here
            body: JSON.stringify({
                success: true,
                message: 'Professional profiles with address details (city, state, pincode) retrieved successfully',
                profiles,
                count: profiles.length
            })
        };
    } catch (error) {
        console.error("Error fetching professional profiles:", error);

        return {
            statusCode: 500,
            headers: headers, // <-- Add headers here even on error
            body: JSON.stringify({
                success: false,
                message: 'Error fetching professional profiles',
                error: error.message
            })
        };
    }
};

exports.handler = handler;