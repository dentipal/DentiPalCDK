import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    GetItemCommandInput,
    UpdateItemCommandInput,
    GetItemCommandOutput,
    UpdateItemCommandOutput // <--- Added this import
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils"; 
import { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } from "./professionalRoles"; 

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!; 

// --- 2. Constants and Type Definitions ---

// ❌ REMOVED INLINE CORS DEFINITION
/*
const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};
*/

/** Interface for the data expected in the request body */
interface UpdateProfileBody {
    role?: string;
    full_name?: string;
    email?: string;
    is_active?: boolean;
    hourly_rate?: number;
    [key: string]: any; 
}

// --- 3. Handler Function ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // ✅ ADDED PREFLIGHT CHECK
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // Validate the token
        const userSub: string = await validateToken(event); 

        if (!event.body) {
             return { statusCode: 400, headers: CORS_HEADERS, body: JSON.stringify({ error: "Request body is required." }) };
        }
        
        const updateData: UpdateProfileBody = JSON.parse(event.body);

        // Validate role if provided
        if (updateData.role && !VALID_ROLE_VALUES.includes(updateData.role)) {
            const validDisplayRoles = VALID_ROLE_VALUES.map(
                role => DB_TO_DISPLAY_MAPPING[role] || role
            ).join(', ');
            
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({
                    error: `Invalid role value provided. Valid options: ${validDisplayRoles}`
                })
            };
        }

        // --- Step 1: Check if profile exists ---
        const getCommand: GetItemCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } }
        };
        
        const existingProfile: GetItemCommandOutput = await dynamodb.send(new GetItemCommand(getCommand));
        
        if (!existingProfile.Item) {
            return {
                statusCode: 404,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "Professional profile not found" })
            };
        }

        // --- Step 2: Build update expression ---
        const updateExpressions: string[] = [];
        const expressionAttributeValues: Record<string, AttributeValue> = {};
        const expressionAttributeNames: Record<string, string> = {};
        let fieldsUpdatedCount: number = 0;
        
        const nowIso: string = new Date().toISOString();

        // Always update the timestamp first
        const updatedTimestampKey = ":updatedAt";
        const updatedTimestampName = "#updatedAt";
        updateExpressions.push(`${updatedTimestampName} = ${updatedTimestampKey}`);
        expressionAttributeNames[updatedTimestampName] = "updatedAt";
        expressionAttributeValues[updatedTimestampKey] = { S: nowIso };

        // Handle all possible fields from updateData
        Object.entries(updateData).forEach(([key, value]) => {
            if (value !== undefined && key !== 'userSub' && key !== 'createdAt') {
                const attrKey = `:${key}`;
                const nameKey = `#${key}`;
                
                updateExpressions.push(`${nameKey} = ${attrKey}`);
                expressionAttributeNames[nameKey] = key;
                fieldsUpdatedCount++;

                // Type mapping logic
                if (typeof value === 'string') {
                    expressionAttributeValues[attrKey] = { S: value };
                } else if (typeof value === 'boolean') {
                    expressionAttributeValues[attrKey] = { BOOL: value };
                } else if (typeof value === 'number') {
                    expressionAttributeValues[attrKey] = { N: value.toString() };
                } else if (Array.isArray(value)) {
                    if (value.every(item => typeof item === 'string')) {
                          expressionAttributeValues[attrKey] = { SS: value.length > 0 ? value : [''] };
                    } else {
                          console.warn(`Skipping field ${key}: Array must contain only strings for SS type.`);
                          fieldsUpdatedCount--; 
                          delete expressionAttributeNames[nameKey];
                          updateExpressions.pop();
                    }
                }
            }
        });

        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Uses imported headers
                body: JSON.stringify({ error: "No fields to update" })
            };
        }

        // --- Step 3: Execute the Update ---
        const updateCommand: UpdateItemCommandInput = {
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: userSub } },
            UpdateExpression: `SET ${updateExpressions.join(", ")}`,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW"
        };

        // FIX: Changed type from GetItemCommandOutput to UpdateItemCommandOutput
        const result: UpdateItemCommandOutput = await dynamodb.send(new UpdateItemCommand(updateCommand));
        
        // Now .Attributes is valid
        const updatedAttributes = result.Attributes;

        // --- Step 4: Return success response ---
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                message: "Professional profile updated successfully",
                profile: {
                    userSub: updatedAttributes?.userSub?.S,
                    role: updatedAttributes?.role?.S,
                    full_name: updatedAttributes?.full_name?.S,
                    updatedAt: updatedAttributes?.updatedAt?.S || nowIso
                }
            })
        };
    } catch (error) {
        const err = error as Error;
        console.error("Error updating professional profile:", err.message, err.stack);
        
        const isAuthError = err.message.includes("Unauthorized") || err.message.includes("token");

        return {
            statusCode: isAuthError ? 401 : 500,
            headers: CORS_HEADERS, // ✅ Uses imported headers
            body: JSON.stringify({
                error: isAuthError ? err.message : "Failed to update professional profile. Please try again.",
                details: isAuthError ? undefined : err.message
            })
        };
    }
};