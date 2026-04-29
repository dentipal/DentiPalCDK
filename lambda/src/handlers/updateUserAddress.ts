import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    GetItemCommandInput,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Added extractUserFromBearerToken
import { extractUserFromBearerToken } from "./utils"; 

// ✅ ADDED THIS LINE:
import { corsHeaders } from "./corsHeaders";
import { geocodeAddressParts } from "./geo";

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
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        
        const requestBody = JSON.parse(event.body || '{}');
        // Cast to unknown first to safely cast to our interface without index signature issues
        const updateFields = requestBody as UpdateAddressFields;

        // Validate that we have at least one field to update
        if (Object.keys(updateFields).length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders(event), 
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
                headers: corsHeaders(event), 
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
                headers: corsHeaders(event),
                body: JSON.stringify({ error: 'No valid fields provided for update after filtering' })
            };
        }

        // --- Re-geocode if any address component changed ---
        const addressFieldsChanged = updatedFields.some((f) =>
            ["addressLine1", "city", "state", "pincode", "country"].includes(f)
        );
        const removeFields: string[] = [];
        let geocodeReport: {
            attempted: boolean;
            ok: boolean;
            source: string | null;
            lat: number | null;
            lng: number | null;
            reason?: string;
        } = { attempted: false, ok: false, source: null, lat: null, lng: null };

        if (addressFieldsChanged) {
            // Merge existing values with incoming updates to build the final address string
            const existing = existingAddress.Item!;
            const getStr = (field: string): string => {
                const incoming = (updateFields as any)[field];
                if (incoming !== undefined && incoming !== null) return String(incoming);
                return existing[field]?.S ?? "";
            };

            const parts = {
                addressLine1: getStr("addressLine1"),
                city: getStr("city"),
                state: getStr("state"),
                pincode: getStr("pincode"),
                country: getStr("country") || "USA",
            };
            const source = [parts.addressLine1, parts.city, parts.state, parts.pincode, parts.country]
                .filter((p) => p && p.trim().length > 0)
                .join(", ");
            geocodeReport.attempted = true;
            geocodeReport.source = source;
            console.log(`[updateUserAddress] Geocoding: "${source}"`);

            const coords = await geocodeAddressParts(parts);
            if (coords) {
                console.log(`[updateUserAddress] Re-geocoded → (${coords.lat}, ${coords.lng})`);
                geocodeReport.ok = true;
                geocodeReport.lat = coords.lat;
                geocodeReport.lng = coords.lng;
                updatedFields.push("lat", "lng");
                expressionAttributeNames["#lat"] = "lat";
                expressionAttributeNames["#lng"] = "lng";
                expressionAttributeValues[":lat"] = { N: String(coords.lat) };
                expressionAttributeValues[":lng"] = { N: String(coords.lng) };
            } else {
                // Geocode failed. Don't keep stale lat/lng from the old address — remove them.
                console.warn(`[updateUserAddress] Geocode returned null for "${source}" — removing any stale lat/lng`);
                geocodeReport.reason = "geocode-null";
                const existingItem = existingAddress.Item!;
                if (existingItem.lat) {
                    expressionAttributeNames["#lat"] = "lat";
                    removeFields.push("#lat");
                }
                if (existingItem.lng) {
                    expressionAttributeNames["#lng"] = "lng";
                    removeFields.push("#lng");
                }
            }
        }

        // --- Step 3: Build update expression ---
        const nowIso: string = new Date().toISOString();
        expressionAttributeNames['#updatedAt'] = 'updatedAt';
        expressionAttributeValues[':updatedAt'] = { S: nowIso };

        const setClause =
            'SET ' +
            [...updatedFields.map((field) => `#${field} = :${field}`), '#updatedAt = :updatedAt'].join(', ');
        const removeClause = removeFields.length > 0 ? ' REMOVE ' + removeFields.join(', ') : '';

        // --- Step 4: Execute update ---
        const updateParams: UpdateItemCommandInput = {
            TableName: USER_ADDRESSES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: setClause + removeClause,
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
                 if (val.S !== undefined) unmarshalledAttributes[key] = val.S;
                 else if (val.N !== undefined) unmarshalledAttributes[key] = Number(val.N);
                 else if (val.BOOL !== undefined) unmarshalledAttributes[key] = val.BOOL;
                 else if (val.SS) unmarshalledAttributes[key] = val.SS;
                 else if (val.L) unmarshalledAttributes[key] = val.L;
                 else if (val.M) unmarshalledAttributes[key] = val.M;
             }
        }

        return {
            statusCode: 200,
            headers: corsHeaders(event),
            body: JSON.stringify({
                message: 'Address updated successfully',
                updatedFields,
                removedFields: removeFields.map((n) => n.replace(/^#/, '')),
                updatedAt: nowIso,
                geocode: geocodeReport,
                address: unmarshalledAttributes
            })
        };
    } catch (error: any) {
        const err = error as Error;
        console.error('Error updating user address:', err.message, err.stack);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        return {
            statusCode: 500,
            headers: corsHeaders(event), 
            body: JSON.stringify({ 
                error: err.message || 'Failed to update user address'
            })
        };
    }
};