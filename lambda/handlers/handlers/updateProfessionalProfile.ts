import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    GetItemCommandInput,
    UpdateItemCommandInput,
    GetItemCommandOutput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken } from "./utils"; 
import { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } from "./professionalRoles"; // Dependency imports

// --- 1. AWS and Environment Setup ---
const REGION: string = process.env.REGION || 'us-east-1';
const dynamodb: DynamoDBClient = new DynamoDBClient({ region: REGION });
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!; // Non-null assertion for env var

// --- 2. Constants and Type Definitions ---

const corsHeaders: Record<string, string> = {
    "Access-Control-Allow-Origin": process.env.CORS_ALLOWED_ORIGIN || "http://localhost:5173",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

/** Interface for the data expected in the request body (allows any key) */
interface UpdateProfileBody {
    role?: string;
    full_name?: string;
    email?: string;
    is_active?: boolean;
    hourly_rate?: number;
    // Allows any other key passed in the request body
    [key: string]: any; 
}

/** Interface for the DynamoDB Profile Item structure (partial view) */
interface ProfileItem {
    userSub?: { S: string };
    role?: { S: string };
    full_name?: { S: string };
    updatedAt?: { S: string };
    [key: string]: AttributeValue | undefined;
}

// --- 3. Handler Function ---

/**
 * Updates a professional user's profile in DynamoDB.
 * Enforces token validation and checks for valid role updates.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // Validate the token and get the userSub (clinic owner)
        // Since the original JS used `await`, we assume it returns a Promise<string>
        const userSub: string = await validateToken(event); 

        if (!event.body) {
             return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Request body is required." }) };
        }
        
        const updateData: UpdateProfileBody = JSON.parse(event.body);

        // Validate role if provided
        if (updateData.role && !VALID_ROLE_VALUES.includes(updateData.role)) {
            const validDisplayRoles = VALID_ROLE_VALUES.map(
                role => DB_TO_DISPLAY_MAPPING[role] || role
            ).join(', ');
            
            return {
                statusCode: 400,
                headers: corsHeaders,
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
                headers: corsHeaders,
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
            // Ensure the key isn't 'userSub' or 'createdAt' which should not be updated directly
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
                    // Assuming string array maps to String Set (SS) or List (L). 
                    // Using SS as it was the pattern in other handlers.
                    if (value.every(item => typeof item === 'string')) {
                         // DynamoDB SS requires at least one non-empty string for valid set
                         expressionAttributeValues[attrKey] = { SS: value.length > 0 ? value : [''] };
                    } else {
                         // Log or handle non-string array elements if necessary
                         console.warn(`Skipping field ${key}: Array must contain only strings for SS type.`);
                         fieldsUpdatedCount--; // Decrement count since this field is skipped
                         delete expressionAttributeNames[nameKey];
                         updateExpressions.pop();
                    }
                }
            }
        });

        if (fieldsUpdatedCount === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
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

        const result: GetItemCommandOutput = await dynamodb.send(new UpdateItemCommand(updateCommand));
        const updatedAttributes = result.Attributes;

        // --- Step 4: Return success response ---
        return {
            statusCode: 200,
            headers: corsHeaders,
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
            headers: corsHeaders,
            body: JSON.stringify({
                error: isAuthError ? err.message : "Failed to update professional profile. Please try again.",
                details: isAuthError ? undefined : err.message
            })
        };
    }
};