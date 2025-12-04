import {
    DynamoDBClient,
    GetItemCommand,
    GetItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client (AWS SDK v3)
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

// --- Type Definitions ---

// Interface for the final mapped response body
interface ClinicAddressResponse {
    clinicId: string;
    name?: string;
    address?: string;
    city?: string;
    state?: string;
    pincode?: string;
}

// --- Main Handler ---

/**
 * AWS Lambda handler to fetch a clinic's address details by its ID.
 * @param event The API Gateway event object.
 * @returns APIGatewayProxyResult.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    console.log("getClinicAddress event:", JSON.stringify(event, null, 2));

    try {
        const path = event.path || "";
        const pathClinicId = event.pathParameters?.clinicId;
        
        // Logic to resolve clinicId from pathParameters or raw path (e.g., /clinics/{id}/address)
        // Keeping original logic: fallback to splitting path if parameter is missing
        const clinicId =
            pathClinicId ||
            path.split("/").filter(Boolean)[1]; 

        console.log("Resolved clinicId:", clinicId, "from path:", path);

        if (!clinicId) {
            return json(400, { error: "Missing clinicId" });
        }

        // 1. Fetch the clinic item from DynamoDB
        const getCommandInput: GetItemCommandInput = {
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        };

        const res = await dynamodb.send(new GetItemCommand(getCommandInput));
        const item = res.Item;

        if (!item) {
            return json(404, { error: "Clinic not found" });
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
        return json(200, body);

    } catch (err: any) {
        console.error("getClinicAddress error:", err);
        return json(500, { error: "Internal server error", details: err.message });
    }
};