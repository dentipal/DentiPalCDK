import {
    DynamoDBClient,
    QueryCommand,
    QueryCommandInput,
    DeleteItemCommand,
    DeleteItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";
// Import validation utility
import { validateToken } from "./utils";

// Initialize the DynamoDB Client
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // --- CORS preflight ---
    // Check standard REST method or HTTP API v2 method
    const method = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Verify token and get userSub
        // Using the standard validateToken which returns the sub string
        const userSub: string = await validateToken(event as any);

        if (!userSub) {
             return json(401, { error: 'Unauthorized - Invalid or expired token' });
        }

        const tableName = process.env.USER_ADDRESSES_TABLE;
        if (!tableName) {
             return json(500, { error: 'Server error: USER_ADDRESSES_TABLE not configured' });
        }

        // 2. Fetch the user's addresses
        const queryInput: QueryCommandInput = {
            TableName: tableName,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": { S: userSub }
            }
        };

        const queryResponse = await dynamodb.send(new QueryCommand(queryInput));

        if (!queryResponse.Items || queryResponse.Items.length === 0) {
            return json(404, { error: 'No addresses found for this user' });
        }

        // 3. Identify Address to Delete (Preserving original logic: deleting the first item found)
        const addressItem = queryResponse.Items[0];
        const addressId = addressItem.addressId?.S;
        
        // DynamoDB BOOL type handling
        const isDefault = addressItem.isDefault?.BOOL;

        if (!addressId) {
             return json(500, { error: 'Database integrity error: Found address without ID' });
        }

        // 4. Check if the address is the default address
        if (isDefault === true) {
            return json(403, {
                error: 'Cannot delete default address. Set another address as default first.'
            });
        }

        // 5. Delete the address
        const deleteInput: DeleteItemCommandInput = {
            TableName: tableName,
            Key: {
                userSub: { S: userSub },
                addressId: { S: addressId }
            }
        };

        await dynamodb.send(new DeleteItemCommand(deleteInput));

        // 6. Success Response
        return json(200, {
            message: 'Address deleted successfully',
            addressId: addressId,
            deletedAt: new Date().toISOString()
        });

    } catch (error) {
        const err = error as Error;
        console.error('Error deleting user address:', err);
        return json(500, { error: 'Failed to delete user address', details: err.message });
    }
};