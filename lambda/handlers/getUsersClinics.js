"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken, isRoot } = require("./utils");

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define CORS headers
const headers = {
    "Access-Control-Allow-Origin": "*", // Allow any origin, modify for stricter security
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS", // Allow specific methods
    "Access-Control-Allow-Headers": "Content-Type, Authorization" // Allow specific headers
};

const handler = async (event) => {
    try {
        // Validate token and retrieve query parameters
        const userSub = validateToken(event); // Get the sub (user identifier) from the token
        const groups = event.requestContext.authorizer?.claims['cognito:groups']?.split(',') || [];
        const queryParams = event.queryStringParameters || {};

        const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;
        const state = queryParams.state;
        const city = queryParams.city;
        const name = queryParams.name;

        const filterExpressions = [];
        const expressionAttributeValues = {};
        const expressionAttributeNames = {};

        // Add filters if they are provided
        if (state) {
            filterExpressions.push("contains(address, :state)");
            expressionAttributeValues[":state"] = { S: state };
        }
        if (city) {
            filterExpressions.push("contains(address, :city)");
            expressionAttributeValues[":city"] = { S: city };
        }
        if (name) {
            filterExpressions.push("contains(#name, :name)");
            expressionAttributeValues[":name"] = { S: name };
            expressionAttributeNames["#name"] = "name";
        }

        // Create DynamoDB scan command
        const scanCommand = {
            TableName: process.env.CLINICS_TABLE,
            Limit: limit
        };

        if (filterExpressions.length > 0) {
            scanCommand.FilterExpression = filterExpressions.join(" AND ");
            scanCommand.ExpressionAttributeValues = expressionAttributeValues;
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

            const clinic = {
                clinicId: item.clinicId?.S || '',
                name: item.name?.S || '',
                addressLine1: item.addressLine1?.S || '',
                addressLine2: item.addressLine2?.S || '',
                addressLine3: item.addressLine3?.S || '',
                city: item.city?.S || '',
                state: item.state?.S || '',
                pincode: item.pincode?.S || '',
                createdAt: item.createdAt?.S || '',
                updatedAt: item.updatedAt?.S || '',
                createdBy,
                associatedUsers
            };
            return clinic;
        });

        let accessibleClinics = clinics;

        // Filter clinics based on the user's sub (if user is root, allow access to all clinics)
        if (!isRoot(groups)) {
            accessibleClinics = clinics.filter(clinic =>
                clinic.createdBy === userSub || clinic.associatedUsers.includes(userSub)
            );
            console.log(`🔒 Non-root user: Filtering clinics for associated user ${userSub}`);
        } else {
            console.log("✅ Root user: Accessing all clinics");
        }

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                status: "success",
                clinics: accessibleClinics,
                totalCount: accessibleClinics.length,
                filters: {
                    state: state || null,
                    city: city || null,
                    name: name || null,
                    limit
                },
                currentUser: {
                    userSub,
                    isRoot: isRoot(groups),
                    groups
                },
                message: `Retrieved ${accessibleClinics.length} clinic(s)`
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
