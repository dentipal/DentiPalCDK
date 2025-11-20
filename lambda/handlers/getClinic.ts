import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken, isRoot, hasClinicAccess } from "./utils"; 

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

// ❌ REMOVED INLINE CORS DEFINITION
/*
// Define common headers
const HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*", // Allow cross-origin requests
};
*/

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
        // 1. Authentication & Authorization Setup
        // validateToken is assumed to return the userSub (string) and throw on failure.
        // Added await to ensure async handling matches other files
        const userSub: string = await validateToken(event as any);
        
        const groupsRaw = (event.requestContext.authorizer as any)?.claims['cognito:groups'];
        const groups: string[] = (typeof groupsRaw === 'string' ? groupsRaw.split(',') : [])
            .map(s => s.trim())
            .filter(Boolean);
            
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
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "Clinic ID is required in path parameters" }) 
            };
        }

        // 3. Access Control Check
        // Root users can access any clinic, others need specific access checked via utility function.
        if (!isRoot(groups) && !(await hasClinicAccess(userSub, clinicId))) {
            return { 
                statusCode: 403, 
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "Access denied to clinic" }) 
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
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "Clinic not found" }) 
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
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                status: "success",
                clinic: clinic,
            }),
        };
    }
    catch (error: any) {
        console.error("Error retrieving clinic:", error);
        return { 
            statusCode: 400, 
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({ error: `Failed to retrieve clinic: ${error.message}` }) 
        };
    }
};