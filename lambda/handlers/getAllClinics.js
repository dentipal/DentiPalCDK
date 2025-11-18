"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken, isRoot } = require("./utils"); // Assuming validateToken and isRoot are defined in utils.js

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define CORS headers
const headers = {
    "Access-Control-Allow-Origin": "*", // Allow any origin, modify for stricter security
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow specific methods
    "Access-Control-Allow-Headers": "Content-Type, Authorization" // Allow specific headers
};

const handler = async (event) => {
    try {
        // Validate token and retrieve user information
        const userSub = validateToken(event);
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        const queryParams = event.queryStringParameters || {};

        const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
        const state = queryParams.state;
        const city = queryParams.city;
        const name = queryParams.name;

        const filterExpressions = [];
        const expressionAttributeValues = {};
        const expressionAttributeNames = {};

        // Add filters if they are provided, using ExpressionAttributeNames for reserved keywords
        if (state) {
            filterExpressions.push("contains(#state_attr, :state)");
            expressionAttributeValues[":state"] = { S: state };
            expressionAttributeNames["#state_attr"] = "state"; // Rename attribute to avoid conflict
        }
        if (city) {
            filterExpressions.push("contains(#city_attr, :city)");
            expressionAttributeValues[":city"] = { S: city };
            expressionAttributeNames["#city_attr"] = "city"; // Rename attribute to avoid conflict
        }
        if (name) {
            filterExpressions.push("contains(#name_attr, :name)"); // Using #name_attr to avoid conflict with 'name' keyword
            expressionAttributeValues[":name"] = { S: name };
            expressionAttributeNames["#name_attr"] = "name";
        }

        // --- Core Logic for User Type Filtering ---
        const isRootUser = isRoot(groups);

        if (isRootUser) {
            // If Root user, filter clinics by 'createdBy' attribute
            filterExpressions.push("createdBy = :userSub");
            expressionAttributeValues[":userSub"] = { S: userSub };
            console.log(`🔒 Root user (${userSub}): Filtering clinics by 'createdBy'.`);
        } else {
            // For non-root users, filter by 'AssociatedUsers' attribute
            filterExpressions.push("contains(AssociatedUsers, :userSub)");
            expressionAttributeValues[":userSub"] = { S: userSub };
            console.log(`🔒 Non-root user (${userSub}): Filtering clinics by 'AssociatedUsers'.`);
        }
        // --- End Core Logic ---

        // Create DynamoDB scan command
        const scanCommand = {
            TableName: process.env.CLINICS_TABLE,
            Limit: limit
        };

        if (filterExpressions.length > 0) {
            scanCommand.FilterExpression = filterExpressions.join(" AND ");
            scanCommand.ExpressionAttributeValues = expressionAttributeValues;
            // Only add ExpressionAttributeNames if there are any to define
            if (Object.keys(expressionAttributeNames).length > 0) {
                scanCommand.ExpressionAttributeNames = expressionAttributeNames;
            }
        }

        // Fetch clinics from DynamoDB
        const response = await dynamoClient.send(new ScanCommand(scanCommand));

        if (!response.Items || response.Items.length === 0) {
            return {
                statusCode: 200,
                headers,
                body: JSON.stringify({
                    status: "success",
                    clinics: [],
                    totalCount: 0,
                    message: "No clinics found"
                })
            };
        }

        console.log("🔍 Raw items from DynamoDB:", JSON.stringify(response.Items, null, 2));

        const clinics = response.Items.map(item => {
            const createdBy = item.createdBy?.S || null;
            const associatedUsersRaw = item.AssociatedUsers?.L || [];

            const associatedUsers = associatedUsersRaw.map(user => user.S);

            // Combine granular address fields into a single 'address' string for frontend compatibility
            const addressParts = [
                item.addressLine1?.S,
                item.addressLine2?.S,
                item.addressLine3?.S,
                item.city?.S,
                item.state?.S,
                item.pincode?.S
            ].filter(Boolean); // Filter out null/undefined/empty strings

            const combinedAddress = addressParts.join(", ");

            const clinic = {
                clinicId: item.clinicId?.S || '',
                name: item.name?.S || '',
                address: combinedAddress, // This matches the frontend Clinic interface
                createdAt: item.createdAt?.S || '',
                updatedAt: item.updatedAt?.S || '',
                createdBy,
                associatedUsers
            };
            return clinic;
        });

        // The filtering is now handled directly by the DynamoDB FilterExpression,
        // so no further filtering is needed here. 'clinics' already contains the correct set.
        
        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                clinics: clinics, // Use the already filtered and mapped clinics
                totalCount: clinics.length,
                filters: {
                    state: state || null,
                    city: city || null,
                    name: name || null,
                    limit
                },
                currentUser: {
                    userSub,
                    isRoot: isRootUser,
                    groups
                },
                message: `Retrieved ${clinics.length} clinic(s)`
            })
        };

    } catch (error) {
        console.error("❌ Error retrieving clinics:", error);
        return {
            statusCode: 500,
            headers,
            body: JSON.stringify({
                error: "Failed to retrieve clinics. Please try again.",
                details: error.message
            })
        };
    }
};

exports.handler = handler;