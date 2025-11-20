import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    GetItemCommandInput,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const dynamodb = new DynamoDBClient({ region: process.env.REGION });
const USER_ADDRESSES_TABLE: string = process.env.USER_ADDRESSES_TABLE!; 

// --- 2. Type Definitions ---

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
    // Removed index signature to ensure keyof evaluates strictly to strings
}

// --- 3. Handler Function ---

/**
 * Updates a user's address in DynamoDB, identified by their userSub.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    const method = event.httpMethod || (event.requestContext as any)?.http?.method;
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Verify JWT token and get user info
        const userSub: string = await validateToken(event as any);
        
        const requestBody = JSON.parse(event.body || '{}');
        // Cast to unknown first to safely cast to our interface without index signature issues
        const updateFields = requestBody as UpdateAddressFields;

        // Validate that we have at least one field to update
        if (Object.keys(updateFields).length === 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, 
                body: JSON.stringify({ error: 'No valid fields provided for update' })
            };
        }

        // --- Step 1: Check if the user has an existing address (for 404 check) ---
        const getParams: GetItemCommandInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub: { S: userSub } }
        };
        const existingAddress = await dynamodb.send(new GetItemCommand(getParams));
        
        if (!existingAddress.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, 
                body: JSON.stringify({ error: 'Address not found for this user' })
            };
        }

        // --- Step 2: Validate and filter update fields ---
        const allowedFields: (keyof UpdateAddressFields)[] = [
            'addressLine1', 'addressLine2', 'city', 'state', 'pincode',
            'country', 'addressType', 'isDefault'
        ];
        
        const updatedFields: string[] = [];
        const expressionAttributeNames: Record<string, string> = {};
        const expressionAttributeValues: Record<string, AttributeValue> = {};
        
        for (const field of allowedFields) {
            // Use Object.prototype.hasOwnProperty for safety with explicit string check
            if (Object.prototype.hasOwnProperty.call(updateFields, field)) {
                const value = updateFields[field];
                
                // Convert to DynamoDB AttributeValue
                let attrValue: AttributeValue | undefined;
                if (typeof value === 'string') {
                    attrValue = { S: value };
                } else if (typeof value === 'boolean') {
                    attrValue = { BOOL: value };
                }

                if (attrValue) {
                    updatedFields.push(field);
                    expressionAttributeNames[`#${field}`] = field;
                    expressionAttributeValues[`:${field}`] = attrValue;
                }
            }
        }

        if (updatedFields.length === 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, 
                body: JSON.stringify({ error: 'No valid fields provided for update after filtering' })
            };
        }

        // --- Step 3: Build update expression ---
        const updateExpression: string =
            'SET ' + updatedFields.map(field => `#${field} = :${field}`).join(', ');
        
        // Add timestamp
        const nowIso: string = new Date().toISOString();
        expressionAttributeNames['#updatedAt'] = 'updatedAt';
        expressionAttributeValues[':updatedAt'] = { S: nowIso };

        // --- Step 4: Execute update ---
        const updateParams: UpdateItemCommandInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: updateExpression + ', #updatedAt = :updatedAt',
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: 'ALL_NEW'
        };

        const result = await dynamodb.send(new UpdateItemCommand(updateParams));

        // --- Step 5: Return success ---
        // Helper to unmarshall simplified object for response
        const unmarshalledAttributes: any = {};
        if (result.Attributes) {
             for (const key in result.Attributes) {
                 const val = result.Attributes[key];
                 if (val.S) unmarshalledAttributes[key] = val.S;
                 if (val.BOOL !== undefined) unmarshalledAttributes[key] = val.BOOL;
             }
        }

        return {
            statusCode: 200,
            headers: CORS_HEADERS, 
            body: JSON.stringify({
                message: 'Address updated successfully',
                updatedFields,
                updatedAt: nowIso,
                address: unmarshalledAttributes
            })
        };
    } catch (error) {
        const err = error as Error;
        console.error('Error updating user address:', err.message, err.stack);
        
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return {
            statusCode: isAuthError ? 401 : 500,
            headers: CORS_HEADERS, 
            body: JSON.stringify({ 
                error: err.message || 'Failed to update user address',
                details: isAuthError ? undefined : err.message
            })
        };
    }
};