import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { 
    DynamoDBDocumentClient, 
    QueryCommand, 
    DeleteCommand, 
    DeleteCommandInput 
} from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS } from "./corsHeaders";

// Initialize Document Client
const REGION = process.env.REGION || "us-east-1";
const client = new DynamoDBClient({ region: REGION });
const ddbDoc = DynamoDBDocumentClient.from(client);

// Helper
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = event.httpMethod || (event.requestContext as any)?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // 1. Authentication
        let userSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
        } catch (authError: any) {
            return json(401, { error: authError.message || "Invalid access token" });
        }

        const tableName = process.env.USER_ADDRESSES_TABLE;
        if (!tableName) {
             return json(500, { error: 'Server error: USER_ADDRESSES_TABLE not configured' });
        }

        // 2. Fetch the user's addresses
        const queryResponse = await ddbDoc.send(new QueryCommand({
            TableName: tableName,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": userSub
            }
        }));

        if (!queryResponse.Items || queryResponse.Items.length === 0) {
            return json(404, { error: 'No addresses found for this user' });
        }

        // 3. Identify Address to Delete 
        // NOTE: Original logic deleted the *first* item found blindly. 
        // Ideally this endpoint should take an addressId parameter.
        // Maintaining original behavior:
        const addressItem = queryResponse.Items[0];
        const addressId = addressItem.addressId;
        
        const isDefault = addressItem.isDefault === true || addressItem.isDefault === "true";

        if (!addressId) {
             return json(500, { error: 'Database integrity error: Found address without ID' });
        }

        // 4. Check if default
        if (isDefault) {
            return json(403, {
                error: 'Cannot delete default address. Set another address as default first.'
            });
        }

        // 5. Delete the address
        const deleteInput: DeleteCommandInput = {
            TableName: tableName,
            Key: {
                userSub: userSub,
                addressId: addressId
            }
        };

        await ddbDoc.send(new DeleteCommand(deleteInput));

        // 6. Success
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