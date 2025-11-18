"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");

// Initialize DynamoDB client
const dynamodb = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
    try {
        // Validate the token to ensure the user is authenticated
        const userSub = await (0, utils_1.validateToken)(event);

        // Scan command to fetch all professional profiles from the table
        const command = new client_dynamodb_1.ScanCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
        });

        // Send the scan command to DynamoDB
        const result = await dynamodb.send(command);

        // Process the result and return the data in the specified structure
        const profiles = await Promise.all(result.Items?.map(async (item) => {
            // Fetch user address details (city, state, pincode) from USER_ADDRESSES_TABLE based on userSub
            const addressCommand = new client_dynamodb_1.QueryCommand({
                TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
                KeyConditionExpression: "userSub = :userSub",
                ExpressionAttributeValues: {
                    ":userSub": { S: item.userSub?.S || '' }
                }
            });

            const addressResult = await dynamodb.send(addressCommand);
            const address = addressResult.Items?.[0] || {};
            
            const city = address.city?.S || '';        // Fetching city
            const state = address.state?.S || '';      // Fetching state
            const zipcode = address.pincode?.S || '';  // Fetching pincode

            // Return the profile with city, state, and pincode fields added
            return {
                userSub: item.userSub?.S || '',  // Fetching userSub from the DynamoDB record
                dentalSoftwareExperience: item.dental_software_experience?.SS || [], // Handle SS type as array of strings
                firstName: item.first_name?.S || '',
                fullName: item.full_name?.S || '',
                lastName: item.last_name?.S || '',
                role: item.role?.S || '',  // Role field is now handled with alias
                specialties: item.specialties?.SS || [], // Handle SS type for specialties as well
                yearsOfExperience: item.years_of_experience?.N ? parseInt(item.years_of_experience.N) : 0,
                city: city,         // Add the city field
                state: state,       // Add the state field
                zipcode: zipcode    // Add the pincode field
            };
        }) || []);

        // Return the response with the processed profiles
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'Professional profiles with address details (city, state, pincode) retrieved successfully',
                profiles,
                count: profiles.length
            }),
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*", // Allow access from any origin
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE", // Allowed HTTP methods
                "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allowed headers
            }
        };
    } catch (error) {
        // Log error for debugging purposes
        console.error("Error fetching professional profiles:", error);

        // Return structured error response
        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                message: 'Error fetching professional profiles',
                error: error.message
            }),
            headers: {
                "Content-Type": "application/json",
                "Access-Control-Allow-Origin": "*", // Allow access from any origin
                "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE", // Allowed HTTP methods
                "Access-Control-Allow-Headers": "Content-Type, Authorization", // Allowed headers
            }
        };
    }
};

exports.handler = handler;
