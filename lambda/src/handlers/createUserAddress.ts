import {
    DynamoDBClient,
    PutItemCommand,
    PutItemCommandInput,
    AttributeValue,
    ScanCommand,
    ScanCommandInput,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils"; // Assuming extractUserFromBearerToken is in utils.ts

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });


// Define the expected structure for the request body
interface AddressRequestBody {
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    state: string;
    pincode: string;
    country?: string;
    addressType?: string;
    isDefault?: boolean;
}

// --- Main Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
    const method =
        (event.requestContext as any)?.http?.method || event.httpMethod || "POST";

    // --- CORS preflight ---
    if (method === "OPTIONS") {
        // ✅ Uses imported headers
        return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Step 1: Authenticate and get user sub - Extract access token
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: authError.message || "Invalid access token"
                })
            };
        }
        
        // Step 2: Parse body and validate required fields
        const addressData: AddressRequestBody = JSON.parse(event.body || "{}");

        if (
            !addressData.addressLine1 ||
            !addressData.city ||
            !addressData.state ||
            !addressData.pincode
        ) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "Required fields: addressLine1, city, state, pincode",
                }),
            };
        }

        const timestamp: string = new Date().toISOString();

        // Step 3: Build DynamoDB item
        // Note: The structure implies userSub is the Partition Key (PK) for a 1:1 relationship.
        const item: Record<string, AttributeValue> = {
            userSub: { S: userSub },
            addressLine1: { S: addressData.addressLine1 },
            city: { S: addressData.city },
            state: { S: addressData.state },
            pincode: { S: addressData.pincode },
            country: { S: addressData.country || "USA" },
            addressType: { S: addressData.addressType || "home" },
            // isDefault defaults to true unless explicitly set to false in the body
            isDefault: { BOOL: addressData.isDefault !== false }, 
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp },
        };

        // Optional fields
        if (addressData.addressLine2) {
            item.addressLine2 = { S: addressData.addressLine2 };
        }
        if (addressData.addressLine3) {
            item.addressLine3 = { S: addressData.addressLine3 };
        }

        // Step 4: Check if the given pincode (zip/postal code) already exists in the table.
        // If it exists, return a 409 with a clear message as requested.
        const tableName = process.env.USER_ADDRESSES_TABLE as string;
        const scanInput: ScanCommandInput = {
            TableName: tableName,
            FilterExpression: "pincode = :pincode",
            ExpressionAttributeValues: {
                ":pincode": { S: addressData.pincode }
            },
            Limit: 1
        };

        try {
            const scanRes = await dynamodb.send(new ScanCommand(scanInput));
            if ((scanRes.Count || 0) > 0) {
                // Found at least one address with same postal code
                return {
                    statusCode: 409,
                    headers: CORS_HEADERS,
                    body: JSON.stringify({ error: `Postal code ${addressData.pincode} already exists in the addresses table` })
                };
            }
        } catch (scanErr) {
            console.warn("Failed to scan for existing pincodes:", scanErr);
            // continue to attempt the put; we don't want to block writes on scan failures
        }

        // Step 5: Write to DynamoDB (no overwrite of the same userSub)
        const putItemInput: PutItemCommandInput = {
            TableName: tableName,
            Item: item,
            ConditionExpression: "attribute_not_exists(userSub)",
        };

        await dynamodb.send(new PutItemCommand(putItemInput));

        // Step 5: Return success response
        return {
            statusCode: 201,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                message: "User address created successfully",
                userSub,
                addressType: addressData.addressType || "home",
            }),
        };
    } catch (error) {
        const err = error as Error & { name?: string; message?: string };
        console.error("Error creating user address:", err);

        // Handle Conditional Check Failed exception (PK collision)
        if (err.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 409,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: "User address already exists. Use PUT to update.",
                }),
            };
        }

        // Handle other errors
        return {
            statusCode: 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({ error: err.message || "Internal Server Error" }),
        };
    }
};

exports.handler = handler;