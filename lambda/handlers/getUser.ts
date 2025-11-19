import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { DynamoDB } from "aws-sdk";
import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AttributeType
} from "@aws-sdk/client-cognito-identity-provider";

// Initialize AWS SDK v2 for DynamoDB DocumentClient
const dynamodb = new DynamoDB.DocumentClient();

// Initialize AWS SDK v3 for CognitoIdentityProviderClient
const cognitoClient = new CognitoIdentityProviderClient({
    region: process.env.REGION
});

// Helper function to extract a specific attribute from Cognito's UserAttributes array
const getAttribute = (attributes: AttributeType[] = [], name: string): string | undefined => {
    const attribute = attributes.find(attr => attr.Name === name);
    return attribute ? attribute.Value : undefined;
};

// Common CORS Headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "http://localhost:5173",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization, X-Amz-Date, X-Api-Key, X-Amz-Security-Token",
    "Access-Control-Allow-Credentials": true
};

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    // Handle OPTIONS preflight requests
    if (event.httpMethod === "OPTIONS") {
        console.log("Received OPTIONS request for preflight.");
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: ""
        };
    }

    try {
        // Step 1: Extract requesterSub from JWT token
        const requesterSub =
            event.requestContext.authorizer?.claims?.["sub"];

        if (!requesterSub) {
            console.error("Requester not authenticated: 'sub' claim missing.");
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "User not authenticated" })
            };
        }

        console.log(`Authenticated requester: ${requesterSub}`);

        // Step 2: Scan clinics table to find clinics associated with requester
        const scanClinicsParams = {
            TableName: "DentiPal-Clinics",
            ProjectionExpression: "clinicId, AssociatedUsers"
        };

        console.log(
            `Scanning DentiPal-Clinics table for clinics associated with ${requesterSub}...`
        );

        const scanClinicsResponse = await dynamodb
            .scan(scanClinicsParams)
            .promise();

        console.log(
            `Scan completed. Found ${scanClinicsResponse.Items?.length || 0} clinics.`
        );

        const clinicsAccessibleByRequester = (scanClinicsResponse.Items || []).filter(
            clinic =>
                clinic.AssociatedUsers &&
                Array.isArray(clinic.AssociatedUsers) &&
                clinic.AssociatedUsers.includes(requesterSub)
        );

        if (clinicsAccessibleByRequester.length === 0) {
            console.log(
                `Requester ${requesterSub} is not associated with any clinics.`
            );
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    status: "success",
                    users: [],
                    requesterId: requesterSub
                })
            };
        }

        console.log(
            `Requester ${requesterSub} is associated with ${clinicsAccessibleByRequester.length} clinics.`
        );

        // Step 3: Collect all unique userSubs to fetch from Cognito
        const uniqueUserSubsToFetch = new Set<string>();

        clinicsAccessibleByRequester.forEach(clinic => {
            (clinic.AssociatedUsers || []).forEach((userSub: string) => {
                uniqueUserSubsToFetch.add(userSub);
            });
        });

        if (uniqueUserSubsToFetch.size === 0) {
            console.log("No associated users found.");
            return {
                statusCode: 200,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    status: "success",
                    users: [],
                    requesterId: requesterSub
                })
            };
        }

        console.log(
            `Found ${uniqueUserSubsToFetch.size} unique users. Fetching details from Cognito...`
        );

        // Step 4: Fetch user details from Cognito
        const userDetailsPromises = Array.from(uniqueUserSubsToFetch).map(
            async userSubToFetch => {
                try {
                    if (!process.env.USER_POOL_ID) {
                        throw new Error(
                            "USER_POOL_ID environment variable is not set."
                        );
                    }

                    const getUserCommand = new AdminGetUserCommand({
                        UserPoolId: process.env.USER_POOL_ID,
                        Username: userSubToFetch
                    });

                    const userResponse = await cognitoClient.send(
                        getUserCommand
                    );

                    const userName =
                        getAttribute(userResponse.UserAttributes, "name") ||
                        `${getAttribute(
                            userResponse.UserAttributes,
                            "given_name"
                        ) || ""} ${getAttribute(
                            userResponse.UserAttributes,
                            "family_name"
                        ) || ""}`.trim();

                    const userEmail = getAttribute(
                        userResponse.UserAttributes,
                        "email"
                    );
                    const userPhoneNumber = getAttribute(
                        userResponse.UserAttributes,
                        "phone_number"
                    );

                    return {
                        sub: userSubToFetch,
                        name: userName || "N/A",
                        email: userEmail || "N/A",
                        phone: userPhoneNumber || "N/A",
                        status: userResponse.UserStatus
                    };
                } catch (cognitoError: any) {
                    console.error(
                        `Error fetching details for user ${userSubToFetch}:`,
                        cognitoError.message
                    );
                    return {
                        sub: userSubToFetch,
                        name: "Error Fetching",
                        email: "Error Fetching",
                        phone: "Error Fetching",
                        error: cognitoError.message
                    };
                }
            }
        );

        const usersList = await Promise.all(userDetailsPromises);

        const successfulUsers = usersList.filter(u => !u.error);
        const usersWithErrors = usersList.filter(u => u.error);

        if (usersWithErrors.length > 0) {
            console.warn(
                `Could not fetch details for ${usersWithErrors.length} user(s).`
            );
        }

        // Step 5: Return final response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                users: successfulUsers,
                requesterId: requesterSub
                // failedToFetchUsers: usersWithErrors  // optional
            })
        };
    } catch (error: any) {
        console.error("Critical error in handler:", error);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: `Failed to retrieve user(s) details: ${error.message}`
            })
        };
    }
};
