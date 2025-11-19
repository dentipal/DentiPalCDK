import { DynamoDB } from "aws-sdk";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { verifyToken } from "./utils"; // Dependency import

// --- 1. AWS and Environment Setup ---
const dynamodb = new DynamoDB.DocumentClient();
const USER_ADDRESSES_TABLE: string = process.env.USER_ADDRESSES_TABLE!; // Non-null assertion for env var

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

// --- 2. Type Definitions ---

/** Interface for the user info returned by verifyToken (partial definition) */
interface UserInfo {
    sub: string;
    [key: string]: any;
}

/** Interface for the fields expected in the request body for updating an address */
interface UpdateAddressFields {
    addressLine1?: string;
    addressLine2?: string;
    city?: string;
    state?: string;
    pincode?: string;
    country?: string;
    addressType?: string;
    isDefault?: boolean;
    [key: string]: any; 
}

// --- 3. Handler Function ---

/**
 * Updates a user's address in DynamoDB, identified by their userSub.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Verify JWT token and get user info
        const userInfo: UserInfo | null = await verifyToken(event);
        
        if (!userInfo) {
            return {
                statusCode: 401,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Unauthorized - Invalid or expired token' })
            };
        }

        const userSub: string = userInfo.sub;
        const requestBody: Record<string, any> = JSON.parse(event.body || '{}');
        const updateFields: UpdateAddressFields = requestBody;

        // Validate that we have at least one field to update
        if (Object.keys(updateFields).length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No valid fields provided for update' })
            };
        }

        // --- Step 1: Check if the user has an existing address (for 404 check) ---
        const getParams: DynamoDB.DocumentClient.GetItemInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub }
        };
        const existingAddress = await dynamodb.get(getParams).promise();
        
        if (!existingAddress.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'Address not found for this user' })
            };
        }

        // --- Step 2: Validate and filter update fields ---
        const allowedFields: (keyof UpdateAddressFields)[] = [
            'addressLine1', 'addressLine2', 'city', 'state', 'pincode',
            'country', 'addressType', 'isDefault'
        ];
        
        const validUpdateFields: Record<string, any> = {};
        const updatedFields: string[] = [];
        
        for (const field of allowedFields) {
            // Check if the field was present in the request body
            if (updateFields.hasOwnProperty(field)) {
                validUpdateFields[field as string] = updateFields[field];
                updatedFields.push(field as string);
            }
        }

        if (updatedFields.length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: 'No valid fields provided for update after filtering' })
            };
        }

        // --- Step 3: Build update expression ---
        const updateExpression: string =
            'SET ' + updatedFields.map(field => `#${field} = :${field}`).join(', ');
            
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, any> = {};
        
        updatedFields.forEach(field => {
            expressionAttributeNames[`#${field}`] = field;
            expressionAttributeValues[`:${field}`] = validUpdateFields[field];
        });
        
        // Add timestamp
        const nowIso: string = new Date().toISOString();
        expressionAttributeNames['#updatedAt'] = 'updatedAt';
        expressionAttributeValues[':updatedAt'] = nowIso;

        // --- Step 4: Execute update ---
        const updateParams: DynamoDB.DocumentClient.UpdateItemInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub },
            UpdateExpression: updateExpression + ', #updatedAt = :updatedAt',
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await dynamodb.update(updateParams).promise();

        // --- Step 5: Return success ---
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: 'Address updated successfully',
                updatedFields,
                updatedAt: nowIso,
                address: result.Attributes
            })
        };
    } catch (error) {
        const err = error as Error;
        console.error('Error updating user address:', err.message, err.stack);
        
        // Use 401 status for explicit authorization/token errors if possible
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return {
            statusCode: isAuthError ? 401 : 500,
            headers: corsHeaders,
            body: JSON.stringify({ 
                error: err.message || 'Failed to update user address',
                details: isAuthError ? undefined : err.message
            })
        };
    }
};