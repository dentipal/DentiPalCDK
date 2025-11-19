// index.ts
import * as AWS from "aws-sdk";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// Use the DynamoDB service client (AWS SDK v2)
const ddb = new AWS.DynamoDB();

const CLINICS_TABLE = process.env.CLINICS_TABLE as string;

// Define interfaces for type safety

// Simplified DynamoDB Item structure
interface DynamoDBClinicItem {
    clinicId?: AWS.DynamoDB.AttributeValue;
    name?: AWS.DynamoDB.AttributeValue;
    address?: AWS.DynamoDB.AttributeValue;
    city?: AWS.DynamoDB.AttributeValue;
    state?: AWS.DynamoDB.AttributeValue;
    pincode?: AWS.DynamoDB.AttributeValue;
}

// Interface for the final mapped response body
interface ClinicAddressResponse {
    clinicId: string;
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
}

// Define common headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Credentials": true,
};

/**
 * AWS Lambda handler to fetch a clinic's address details by its ID.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.log("getClinicAddress event:", JSON.stringify(event, null, 2));

    try {
        const path = event.path || "";
        const pathClinicId = event.pathParameters?.clinicId;
        
        // Logic to resolve clinicId from pathParameters or raw path (e.g., /clinics/{id}/address)
        const clinicId =
            pathClinicId ||
            path.split("/").filter(Boolean)[1]; 

        console.log("Resolved clinicId:", clinicId, "from path:", path);

        if (!clinicId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Missing clinicId" }),
            };
        }

        // 1. Fetch the clinic item from DynamoDB
        const res = await ddb
            .getItem({
                TableName: CLINICS_TABLE,
                Key: { clinicId: { S: clinicId } },
            })
            .promise();

        const item = res.Item as DynamoDBClinicItem | undefined;

        if (!item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: "Clinic not found" }),
            };
        }

        // 2. Map and unwrap the attributes
        const body: ClinicAddressResponse = {
            clinicId,
            name: item.name?.S,
            address: item.address?.S,
            city: item.city?.S,
            state: item.state?.S,
            pincode: item.pincode?.S,
        };

        // 3. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify(body),
        };
    } catch (err: any) {
        console.error("getClinicAddress error:", err);
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: "Internal server error", details: err.message }),
        };
    }
};