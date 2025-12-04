import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { isRoot, hasClinicAccess, extractUserFromBearerToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// Define interfaces for type safety

// Simplified type for a raw DynamoDB item
interface DynamoDBClinicItem {
    clinicId: AttributeValue;
    name: AttributeValue;
    addressLine1: AttributeValue;
    addressLine2?: AttributeValue;
    addressLine3?: AttributeValue;
    city: AttributeValue;
    state: AttributeValue;
    pincode: AttributeValue;
    address: AttributeValue; // Assuming this holds the combined fullAddress
    createdBy: AttributeValue;
    createdAt: AttributeValue;
    updatedAt: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped clinic object
interface ClinicResponse {
    clinicId: string;
    name: string;
    addressLine1: string;
    addressLine2: string;
    addressLine3: string;
    city: string;
    state: string;
    pincode: string;
    fullAddress: string;
    createdBy: string;
    createdAt: string;
    updatedAt: string;
}

/**
 * AWS Lambda handler to retrieve details for a specific clinic, subject to access control.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        
        const userSub = userInfo.sub;
        const groups = userInfo.groups || [];
            
        let clinicId: string | undefined = event.pathParameters?.proxy;
        console.log("Extracted clinicId:", clinicId);
        
        // 2. Clean the clinicId path parameter
        if (clinicId?.startsWith('clinics/')) {
            clinicId = clinicId.slice('clinics/'.length);
        }

        console.log("Cleaned clinicId:", clinicId);

        if (!clinicId) {
            return { 
                statusCode: 400, 
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    statusCode: 400,
                    message: "Clinic ID is required",
                    details: { pathFormat: "/clinics/{clinicId}" },
                    timestamp: new Date().toISOString()
                })
            };
        }

        // 3. Access Control Check
        // Root users can access any clinic, others need specific access checked via utility function.
        if (!isRoot(groups) && !(await hasClinicAccess(userSub, clinicId))) {
            return { 
                statusCode: 403, 
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Forbidden",
                    statusCode: 403,
                    message: "Access denied to clinic",
                    details: { clinicId: clinicId, requiredAccess: "clinic-owner" },
                    timestamp: new Date().toISOString()
                })
            };
        }

        // 4. Fetch the clinic details from DynamoDB
        const command = new GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        });
        const response: GetItemCommandOutput = await dynamoClient.send(command);

        console.log("DynamoDB response:", response); 
        const item = response.Item as DynamoDBClinicItem | undefined;

        // If clinic not found
        if (!item) {
            return { 
                statusCode: 404, 
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Not Found",
                    statusCode: 404,
                    message: "Clinic not found",
                    details: { clinicId: clinicId },
                    timestamp: new Date().toISOString()
                })
            };
        }

        // 5. Map and Return the clinic details
        const clinic: ClinicResponse = {
            clinicId: item.clinicId.S || '',
            name: item.name.S || '',
            addressLine1: item.addressLine1.S || '',
            addressLine2: item.addressLine2?.S || '',
            addressLine3: item.addressLine3?.S || '',
            city: item.city.S || '',
            state: item.state.S || '',
            pincode: item.pincode.S || '',
            fullAddress: item.address.S || '', // Assuming 'address' holds the combined address
            createdBy: item.createdBy.S || '',
            createdAt: item.createdAt.S || '',
            updatedAt: item.updatedAt.S || '',
        };

        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 200,
                message: "Clinic retrieved successfully",
                data: clinic,
                timestamp: new Date().toISOString()
            }),
        };
    }
    catch (error: any) {
        console.error("Error retrieving clinic:", error);

        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                })
            };
        }

        return { 
            statusCode: 500, 
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Internal Server Error",
                statusCode: 500,
                message: "Failed to retrieve clinic",
                details: { reason: error.message },
                timestamp: new Date().toISOString()
            })
        };
    }
};