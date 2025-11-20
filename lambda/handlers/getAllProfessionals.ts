import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    AttributeValue,
    ScanCommandOutput,
    QueryCommandOutput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file exports the necessary functions and types
import { validateToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- Type Definitions ---

// Simplified type for a raw DynamoDB profile item
interface DynamoDBProfileItem {
    userSub?: AttributeValue;
    dental_software_experience?: AttributeValue; // SS
    first_name?: AttributeValue;
    full_name?: AttributeValue;
    last_name?: AttributeValue;
    role?: AttributeValue;
    specialties?: AttributeValue; // SS
    years_of_experience?: AttributeValue; // N
    [key: string]: AttributeValue | undefined;
}

// Simplified type for a raw DynamoDB address item
interface DynamoDBAddressItem {
    city?: AttributeValue;
    state?: AttributeValue;
    pincode?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

// Interface for the final mapped profile object
interface ProfileResponseItem {
    userSub: string;
    dentalSoftwareExperience: string[];
    firstName: string;
    fullName: string;
    lastName: string;
    role: string;
    specialties: string[];
    yearsOfExperience: number;
    city: string;
    state: string;
    zipcode: string;
}

// ❌ REMOVED INLINE CORS DEFINITION
/*
// Define common headers
const COMMON_HEADERS = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};
*/

/**
 * AWS Lambda handler to retrieve all professional profiles and enrich them with address details.
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
        // 1. Validate the token to ensure the user is authenticated
        // validateToken is assumed to return the userSub (string) and throw on failure.
        const userSub: string = await validateToken(event);

        // 2. Scan professional profiles table
        const scanCommand = new ScanCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE, // DentiPal-ProfessionalProfiles
        });

        const result: ScanCommandOutput = await dynamodb.send(scanCommand);
        const rawProfiles: DynamoDBProfileItem[] = (result.Items as DynamoDBProfileItem[] || []);

        // 3. Process the result and fetch addresses concurrently
        const profiles: ProfileResponseItem[] = await Promise.all(rawProfiles.map(async (item) => {
            const currentSub = item.userSub?.S || '';

            // Fetch user address details (city, state, pincode) from USER_ADDRESSES_TABLE
            const addressCommand = new QueryCommand({
                TableName: process.env.USER_ADDRESSES_TABLE, // DentiPal-UserAddresses
                KeyConditionExpression: "userSub = :userSub",
                ExpressionAttributeValues: {
                    ":userSub": { S: currentSub }
                }
            });

            const addressResult: QueryCommandOutput = await dynamodb.send(addressCommand);
            const address: DynamoDBAddressItem = (addressResult.Items?.[0] as DynamoDBAddressItem) || {};
            
            const city = address.city?.S || ''; 
            const state = address.state?.S || ''; 
            const zipcode = address.pincode?.S || ''; 
            
            // Extract and transform profile fields
            const dentalSoftwareExperience: string[] = item.dental_software_experience?.SS || [];
            const specialties: string[] = item.specialties?.SS || [];
            const yearsOfExperience: number = item.years_of_experience?.N ? parseInt(item.years_of_experience.N, 10) : 0;
            
            // Return the structured profile
            return {
                userSub: currentSub,
                dentalSoftwareExperience: dentalSoftwareExperience,
                firstName: item.first_name?.S || '',
                fullName: item.full_name?.S || '',
                lastName: item.last_name?.S || '',
                role: item.role?.S || '',
                specialties: specialties,
                yearsOfExperience: yearsOfExperience,
                city: city,
                state: state,
                zipcode: zipcode
            };
        }));

        // 4. Return the successful response
        return {
            statusCode: 200,
            body: JSON.stringify({
                success: true,
                message: 'Professional profiles with address details (city, state, pincode) retrieved successfully',
                profiles,
                count: profiles.length
            }),
            headers: CORS_HEADERS, // ✅ Uses imported headers
        };
    } catch (error: any) {
        // 5. Handle and return error response
        console.error("Error fetching professional profiles:", error);

        return {
            statusCode: 500,
            body: JSON.stringify({
                success: false,
                message: 'Error fetching professional profiles',
                error: error.message
            }),
            headers: CORS_HEADERS, // ✅ Uses imported headers
        };
    }
};