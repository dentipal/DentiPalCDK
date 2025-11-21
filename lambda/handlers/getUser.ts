import {
    DynamoDBClient,
    ScanCommand,
    ScanCommandInput,
    AttributeValue
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AttributeType
} from "@aws-sdk/client-cognito-identity-provider";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { CORS_HEADERS } from "./corsHeaders";
// ✅ ADDED: Import auth utility
import { extractUserFromBearerToken } from "./utils";

// --- Configuration ---
const REGION = process.env.REGION || "us-east-1";
const CLINICS_TABLE = process.env.CLINICS_TABLE || "DentiPal-Clinics";
const USER_POOL_ID = process.env.USER_POOL_ID;

// Initialize AWS SDK v3 Clients
const dynamodbClient = new DynamoDBClient({ region: REGION });
const cognitoClient = new CognitoIdentityProviderClient({ region: REGION });

// --- Types ---
interface AssociatedClinic {
    clinicId: string;
    AssociatedUsers?: string[];
    [key: string]: any;
}

interface UserDetails {
    sub: string;
    name: string;
    email: string;
    phone: string;
    status?: string;
    error?: string;
}

// --- Helpers ---

// Helper function to extract a specific attribute from Cognito's UserAttributes array
const getAttribute = (attributes: AttributeType[] = [], name: string): string | undefined => {
    const attribute = attributes.find(attr => attr.Name === name);
    return attribute ? attribute.Value : undefined;
};

// Helper to build JSON responses
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle OPTIONS preflight requests
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        
        // This extracts and validates the token. Throws error if invalid.
        const userInfo = extractUserFromBearerToken(authHeader);
        const requesterSub = userInfo.sub;

        console.log(`Authenticated requester: ${requesterSub}`);

        // Step 2: Scan clinics table to find clinics associated with requester
        // Note: Scanning filter logic allows finding clinics where the user is listed in AssociatedUsers.
        // For efficiency in production, a GSI on AssociatedUsers is recommended.
        const scanClinicsParams: ScanCommandInput = {
            TableName: CLINICS_TABLE,
            ProjectionExpression: "clinicId, AssociatedUsers"
        };

        console.log(`Scanning ${CLINICS_TABLE} table for clinics associated with ${requesterSub}...`);

        const scanCommand = new ScanCommand(scanClinicsParams);
        const scanClinicsResponse = await dynamodbClient.send(scanCommand);

        // Unmarshall DynamoDB items to plain JS objects for easier handling
        const allClinics = (scanClinicsResponse.Items || []).map(item => 
            unmarshall(item) as AssociatedClinic
        );

        console.log(`Scan completed. Found ${allClinics.length} total clinics.`);

        // Filter in memory (if not using FilterExpression)
        const clinicsAccessibleByRequester = allClinics.filter(clinic => 
            clinic.AssociatedUsers &&
            Array.isArray(clinic.AssociatedUsers) &&
            clinic.AssociatedUsers.includes(requesterSub)
        );

        if (clinicsAccessibleByRequester.length === 0) {
            console.log(`Requester ${requesterSub} is not associated with any clinics.`);
            return json(200, {
                status: "success",
                statusCode: 200,
                message: "No clinics found for requester",
                data: {
                    users: [],
                    requesterId: requesterSub
                },
                timestamp: new Date().toISOString()
            });
        }

        console.log(`Requester ${requesterSub} is associated with ${clinicsAccessibleByRequester.length} clinics.`);

        // Step 3: Collect all unique userSubs to fetch from Cognito
        const uniqueUserSubsToFetch = new Set<string>();

        clinicsAccessibleByRequester.forEach(clinic => {
            (clinic.AssociatedUsers || []).forEach((userSub) => {
                uniqueUserSubsToFetch.add(userSub);
            });
        });

        if (uniqueUserSubsToFetch.size === 0) {
            return json(200, {
                status: "success",
                statusCode: 200,
                message: "No associated users found",
                data: {
                    users: [],
                    requesterId: requesterSub
                },
                timestamp: new Date().toISOString()
            });
        }

        console.log(`Found ${uniqueUserSubsToFetch.size} unique users. Fetching details from Cognito...`);

        // Step 4: Fetch user details from Cognito
        if (!USER_POOL_ID) {
            console.error("USER_POOL_ID environment variable is not set.");
            return json(500, { error: "Configuration error: USER_POOL_ID missing" });
        }

        const userDetailsPromises = Array.from(uniqueUserSubsToFetch).map(async (userSubToFetch): Promise<UserDetails> => {
            try {
                const getUserCommand = new AdminGetUserCommand({
                    UserPoolId: USER_POOL_ID,
                    Username: userSubToFetch
                });

                const userResponse = await cognitoClient.send(getUserCommand);

                const userName =
                    getAttribute(userResponse.UserAttributes, "name") ||
                    `${getAttribute(userResponse.UserAttributes, "given_name") || ""} ${getAttribute(userResponse.UserAttributes, "family_name") || ""}`.trim();

                const userEmail = getAttribute(userResponse.UserAttributes, "email");
                const userPhoneNumber = getAttribute(userResponse.UserAttributes, "phone_number");

                return {
                    sub: userSubToFetch,
                    name: userName || "N/A",
                    email: userEmail || "N/A",
                    phone: userPhoneNumber || "N/A",
                    status: userResponse.UserStatus
                };
            } catch (cognitoError: any) {
                console.error(`Error fetching details for user ${userSubToFetch}:`, cognitoError.message);
                return {
                    sub: userSubToFetch,
                    name: "Error Fetching",
                    email: "Error Fetching",
                    phone: "Error Fetching",
                    error: cognitoError.message
                };
            }
        });

        const usersList = await Promise.all(userDetailsPromises);
        const successfulUsers = usersList.filter(u => !u.error);
        const usersWithErrors = usersList.filter(u => u.error);

        if (usersWithErrors.length > 0) {
            console.warn(`Could not fetch details for ${usersWithErrors.length} user(s).`);
        }

        // Step 5: Return final response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: `Retrieved ${successfulUsers.length} user(s)`,
            data: {
                users: successfulUsers,
                requesterId: requesterSub,
                failedCount: usersWithErrors.length
            },
            timestamp: new Date().toISOString()
        });

    } catch (error: any) {
        console.error("Critical error in handler:", error);

        // Auth specific error handling
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to retrieve user(s) details",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};