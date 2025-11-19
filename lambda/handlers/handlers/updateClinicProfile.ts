import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Buffer } from 'node:buffer'; // Used for base64url decoding

// --- Type Definitions ---

/** Claims decoded from the JWT payload */
interface JwtClaims {
    sub: string;
    "cognito:groups"?: string | string[];
    "custom:user_type"?: string;
    [key: string]: any;
}

/** Fields allowed for update in the clinic profile */
interface UpdateFields {
    clinic_name?: string;
    city?: string;
    state?: string;
    website?: string;
    primary_contact_first_name?: string;
    primary_contact_last_name?: string;
    practice_type?: string;
    primary_practice_area?: string;
    number_of_operatories?: number;
    booking_out_period?: string;
    free_parking_available?: boolean;
    parking_type?: string;
    description?: string;
    specialties?: string[] | string;
    business_hours?: Record<string, any>;
    [key: string]: any; 
}

/** Full request body structure */
interface RequestBody extends UpdateFields {
    profileId?: string;
}

// --- Client Initialization ---

// Use DynamoDBClient for the underlying client
const ddbClient = new DynamoDBClient({}); 
// Use DocumentClient (lib-dynamodb) for easier object handling
const dynamodb = DynamoDBDocumentClient.from(ddbClient);

const CLINIC_PROFILES_TABLE: string | undefined = process.env.CLINIC_PROFILES_TABLE;

// --- Constants ---

const ALLOWED_FIELDS: ReadonlyArray<keyof UpdateFields> = [
    "clinic_name", "city", "state", "website", "primary_contact_first_name",
    "primary_contact_last_name", "practice_type", "primary_practice_area",
    "number_of_operatories", "booking_out_period", "free_parking_available",
    "parking_type", "description", "specialties", "business_hours"
];

// --- Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🔧 Starting updateClinicProfile handler");

    try {
        if (!CLINIC_PROFILES_TABLE) {
            console.error("❌ CLINIC_PROFILES_TABLE environment variable is not set.");
            return {
                statusCode: 500,
                body: JSON.stringify({ error: "Server configuration error: Table not defined." }),
            };
        }

        // Step 1: Decode JWT token manually
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.error("❌ Missing or invalid Authorization header");
            return {
                statusCode: 401,
                body: JSON.stringify({ error: "Missing or invalid Authorization header" }),
            };
        }

        const token = authHeader.split(" ")[1];
        const payload = token.split(".")[1];
        
        // Decode the Base64URL payload
        const decodedClaims: JwtClaims = JSON.parse(
            Buffer.from(payload, "base64url").toString("utf8")
        );

        const userSub: string = decodedClaims.sub;
        
        // Normalize groups into a string array
        const rawGroups = decodedClaims["cognito:groups"];
        const groups: string[] = Array.isArray(rawGroups) 
            ? rawGroups.map(String) 
            : (typeof rawGroups === 'string' 
                ? rawGroups.split(',').map(s => s.trim()).filter(Boolean) 
                : []);
        
        const userType: string = decodedClaims["custom:user_type"] || "professional";

        // Step 2: Get clinicId from API Gateway proxy path (replicating original path split logic)
        const pathParts: string[] = event.path?.split("/") || [];
        const clinicId: string | undefined = pathParts.pop();

        console.info("📦 Decoded claims:", decodedClaims);
        console.info("🏥 Extracted clinicId from path:", clinicId);

        if (!clinicId || !userSub) {
            console.error("❌ Missing clinicId or userSub");
            return {
                statusCode: 401,
                body: JSON.stringify({ error: "Missing clinicId or userSub" }),
            };
        }

        // Step 3: Verify user is clinic or Root
        const isClinicUser = userType.toLowerCase() === "clinic" || groups.includes("clinic");
        const isRootUser = groups.includes("Root");

        if (!isClinicUser && !isRootUser) {
            console.warn("🚫 Unauthorized userType for profile update:", userType);
            return {
                statusCode: 403,
                body: JSON.stringify({ error: "Access denied – only clinic users can update clinic profiles" }),
            };
        }

        // Step 4: Parse body and validate
        const requestBody: RequestBody = JSON.parse(event.body || "{}");
        const { profileId, ...updateFields } = requestBody;

        if (!profileId) {
            console.warn("⚠️ profileId missing in request body");
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "profileId is required" }),
            };
        }

        // Step 5: Confirm profile exists (using GetCommand for DocumentClient)
        const getCommand = new GetCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId,
                userSub
            },
        });

        const existingProfile = await dynamodb.send(getCommand);

        if (!existingProfile.Item) {
            console.warn("⚠️ Clinic profile not found for clinicId:", clinicId);
            return {
                statusCode: 404,
                body: JSON.stringify({ error: "Clinic profile not found" }),
            };
        }

        // Step 6: Prepare allowed fields
        const validUpdateFields: Partial<UpdateFields> = {};
        const updatedFields: string[] = [];

        for (const key of Object.keys(updateFields) as (keyof UpdateFields)[]) {
            if (ALLOWED_FIELDS.includes(key)) {
                const value = updateFields[key];
                if (value !== undefined && value !== null) {
                    validUpdateFields[key] = value as any;
                    updatedFields.push(key as string);
                }
            }
        }

        if (updatedFields.length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No valid fields provided for update" }),
            };
        }

        // Step 7: Build update expression
        const updateExpressionParts: string[] = [];
        const expressionAttributeNames: Record<string, string> = { "#updatedAt": "updatedAt" };
        const expressionAttributeValues: Record<string, any> = { ":updatedAt": new Date().toISOString() };

        updatedFields.forEach(field => {
            const aliasName = `#${field}`;
            const aliasValue = `:${field}`;
            
            updateExpressionParts.push(`${aliasName} = ${aliasValue}`);
            
            expressionAttributeNames[aliasName] = field;
            expressionAttributeValues[aliasValue] = validUpdateFields[field as keyof UpdateFields];
        });
        
        const updateExpression = "SET " + updateExpressionParts.join(", ");

        const updateCommand = new UpdateCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId,
                userSub
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        });

        const result = await dynamodb.send(updateCommand);

        console.info("✅ Clinic profile updated:", result.Attributes);

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Clinic profile updated successfully",
                profileId,
                updatedFields,
                updatedAt: new Date().toISOString(),
                profile: result.Attributes,
            }),
        };
    } catch (error) {
        console.error("❌ Error in updateClinicProfile:", error);
        
        // Use a type guard for better error handling
        const errorMessage = (error as Error).message;
        
        if (errorMessage.includes("Missing or invalid Authorization")) {
             return { statusCode: 401, body: JSON.stringify({ error: errorMessage }) };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to update clinic profile" }),
        };
    }
};