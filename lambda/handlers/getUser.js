"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDB } = require('aws-sdk');
const client_cognito_identity_provider_1 = require("@aws-sdk/client-cognito-identity-provider");

// Initialize AWS SDK v2 for DynamoDB DocumentClient
const dynamodb = new DynamoDB.DocumentClient();

// Initialize AWS SDK v3 for CognitoIdentityProviderClient
const cognitoClient = new client_cognito_identity_provider_1.CognitoIdentityProviderClient({ region: process.env.REGION });

// Helper function to extract a specific attribute from Cognito's UserAttributes array
const getAttribute = (attributes, name) => {
    const attribute = attributes.find(attr => attr.Name === name);
    return attribute ? attribute.Value : undefined;
};

// Define common CORS headers
// IMPORTANT: For production, replace "http://localhost:5173" with your actual frontend domain(s).
// For multiple domains, you'd need more complex logic (e.g., check Origin header and respond dynamically)
// For broader testing (less secure for production), you can use "*"
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "http://localhost:5173", // <-- CHANGE THIS TO YOUR FRONTEND URL OR '*'
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS", // Add all methods your API will use
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Credentials": true // Set to true if you are handling cookies or HTTP auth (less common with JWT in Authorization header)
};

const handler = async (event) => {
    // Handle OPTIONS preflight requests explicitly if API Gateway isn't doing it
    if (event.httpMethod === 'OPTIONS') {
        console.log("Received OPTIONS request for preflight.");
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: '' // OPTIONS requests typically have an empty body
        };
    }

    try {
        // Step 1: Extract the userSub (the requester's ID) from the JWT token
        const requesterSub = event.requestContext.authorizer?.claims['sub'];
        if (!requesterSub) {
            console.error("Requester not authenticated: 'sub' claim missing.");
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // Include CORS headers in error response
                body: JSON.stringify({ error: "User not authenticated" })
            };
        }
        console.log(`Authenticated requester: ${requesterSub}`);

        // --- As per your request, the group-based authorization check is REMOVED ---
        // Any authenticated user can now view users associated with their clinics.

        // Step 2: Find all clinics where the requesterSub exists in AssociatedUsers
        // This determines which clinics the current user has access to.
        const scanClinicsParams = {
            TableName: "DentiPal-Clinics",
            ProjectionExpression: "clinicId, AssociatedUsers", // Only fetch necessary attributes
        };

        console.log(`Scanning DentiPal-Clinics table for clinics associated with ${requesterSub}...`);
        const scanClinicsResponse = await dynamodb.scan(scanClinicsParams).promise();
        console.log(`Scan completed. Found ${scanClinicsResponse.Items.length} clinics.`);

        const clinicsAccessibleByRequester = scanClinicsResponse.Items.filter(
            clinic => clinic.AssociatedUsers && Array.isArray(clinic.AssociatedUsers) && clinic.AssociatedUsers.includes(requesterSub)
        );

        if (clinicsAccessibleByRequester.length === 0) {
            console.log(`Requester ${requesterSub} is not associated with any clinics.`);
            return {
                statusCode: 200,
                headers: CORS_HEADERS, // Include CORS headers
                body: JSON.stringify({
                    status: "success",
                    users: [], // No clinics, so no associated users to display
                    requesterId: requesterSub
                }),
            };
        }
        console.log(`Requester ${requesterSub} is associated with ${clinicsAccessibleByRequester.length} clinics.`);

        // Step 3: Collect all unique userSubs from the 'AssociatedUsers' of these accessible clinics
        const uniqueUserSubsToFetch = new Set();
        clinicsAccessibleByRequester.forEach(clinic => {
            clinic.AssociatedUsers.forEach(userSub => {
                uniqueUserSubsToFetch.add(userSub);
            });
        });

        if (uniqueUserSubsToFetch.size === 0) {
            console.log("No associated users found in the accessible clinics.");
            return {
                statusCode: 200,
                headers: CORS_HEADERS, // Include CORS headers
                body: JSON.stringify({
                    status: "success",
                    users: [],
                    requesterId: requesterSub
                }),
            };
        }
        console.log(`Found ${uniqueUserSubsToFetch.size} unique users across accessible clinics. Fetching details from Cognito...`);


        // Step 4: Fetch details for each unique userSub from Cognito User Pool
        const userDetailsPromises = Array.from(uniqueUserSubsToFetch).map(async (userSubToFetch) => {
            try {
                // Ensure USER_POOL_ID environment variable is set in your Lambda configuration
                if (!process.env.USER_POOL_ID) {
                    throw new Error("USER_POOL_ID environment variable is not set.");
                }

                const getUserCommand = new client_cognito_identity_provider_1.AdminGetUserCommand({
                    UserPoolId: process.env.USER_POOL_ID,
                    Username: userSubToFetch, // In Cognito, 'sub' is usually the Username for AdminGetUser
                });
                
                const userResponse = await cognitoClient.send(getUserCommand);
                
                // Extract common attributes. Adjust attribute names if your Cognito User Pool uses different ones.
                const userName = getAttribute(userResponse.UserAttributes, 'name') || 
                                 `${getAttribute(userResponse.UserAttributes, 'given_name') || ''} ${getAttribute(userResponse.UserAttributes, 'family_name') || ''}`.trim();
                const userEmail = getAttribute(userResponse.UserAttributes, 'email');
                const userPhoneNumber = getAttribute(userResponse.UserAttributes, 'phone_number');

                return {
                    sub: userSubToFetch,
                    name: userName || 'N/A', // Fallback if name is not set
                    email: userEmail || 'N/A',
                    phone: userPhoneNumber || 'N/A',
                    status: userResponse.UserStatus // e.g., CONFIRMED, UNCONFIRMED, FORCE_CHANGE_PASSWORD
                };
            } catch (cognitoError) {
                console.error(`Error fetching details for user ${userSubToFetch} from Cognito:`, cognitoError.message);
                // Return a partial user object with error info or omit this user if desired
                return {
                    sub: userSubToFetch,
                    name: 'Error Fetching',
                    email: 'Error Fetching',
                    phone: 'Error Fetching',
                    error: cognitoError.message
                };
            }
        });

        const usersList = await Promise.all(userDetailsPromises);

        // Filter out users that had errors if you don't want to send error objects to frontend
        const successfulUsers = usersList.filter(user => !user.error);
        const usersWithErrors = usersList.filter(user => user.error);
        
        if (usersWithErrors.length > 0) {
            console.warn(`Could not fetch details for ${usersWithErrors.length} user(s). See logs for details.`);
        }

        // Step 5: Return the list of fetched user details
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // Include CORS headers in success response
            body: JSON.stringify({
                status: "success",
                users: successfulUsers, // The list of users with their details
                requesterId: requesterSub,
                // Optionally, include failed users for frontend debugging
                // failedToFetchUsers: usersWithErrors 
            }),
        };

    } catch (error) {
        console.error("Critical error in handler:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // Include CORS headers in critical error response
            body: JSON.stringify({ error: `Failed to retrieve user(s) details: ${error.message}` })
        };
    }
};

exports.handler = handler;