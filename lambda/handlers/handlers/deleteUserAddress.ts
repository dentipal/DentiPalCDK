// index.ts
import { DynamoDB } from "aws-sdk";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Assuming the utility file contains the interface for the user info returned by verifyToken
import { verifyToken, UserInfo } from "./utils"; 

// Initialize the DynamoDB DocumentClient
// Note: This uses AWS SDK v2's DynamoDB.DocumentClient, which is common.
const dynamodb = new DynamoDB.DocumentClient();

// Get environment variable
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE as string;

// Define interfaces for better type safety
interface AddressItem {
    userSub: string;
    addressId: string;
    isDefault?: boolean;
    [key: string]: any;
}

// Define CORS headers
const corsHeaders = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

/**
 * AWS Lambda handler to delete a user address.
 * * NOTE: The original code queries ALL addresses for the userSub and attempts 
 * to delete the FIRST one found (Items[0]). It lacks logic to identify 
 * a specific addressId from the request path or body. This functionality 
 * is preserved to match the original code exactly.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Verify JWT token and get user info
        const userInfo: UserInfo | null = await verifyToken(event);
        if (!userInfo) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized - Invalid or expired token' })
            };
        }
        const userSub = userInfo.sub;

        // 2. Fetch the user's addresses
        const getParams: DynamoDB.DocumentClient.QueryInput = {
            TableName: USER_ADDRESSES_TABLE,
            KeyConditionExpression: "userSub = :userSub",
            ExpressionAttributeValues: {
                ":userSub": userSub
            }
        };
        const existingAddresses = await dynamodb.query(getParams).promise();

        if (!existingAddresses.Items || existingAddresses.Items.length === 0) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No addresses found for this user' })
            };
        }

        // 3. Identify Address to Delete (Preserving original logic: deleting the first item)
        const addressToDelete: AddressItem = existingAddresses.Items[0] as AddressItem;

        // 4. Check if the address is the default address
        if (addressToDelete.isDefault === true) {
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({
                    error: 'Cannot delete default address. Set another address as default first.'
                })
            };
        }

        // 5. Delete the address
        const deleteParams: DynamoDB.DocumentClient.DeleteItemInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: {
                userSub: userSub,
                addressId: addressToDelete.addressId // Requires addressId to be the Sort Key
            }
        };

        await dynamodb.delete(deleteParams).promise();

        // 6. Success Response
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Address deleted successfully',
                addressId: addressToDelete.addressId,
                deletedAt: new Date().toISOString()
            })
        };
    }
    catch (error: any) {
        console.error('Error deleting user address:', error);
        return {
            statusCode: 500,
            headers: corsHeaders,
            body: JSON.stringify({ error: 'Failed to delete user address', details: error.message })
        };
    }
};