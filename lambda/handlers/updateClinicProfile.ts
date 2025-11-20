import { 
    DynamoDBClient, 
    GetItemCommand, 
    UpdateItemCommand, 
    AttributeValue,
    UpdateItemCommandInput
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Buffer } from 'buffer'; 

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
    specialties?: string[];
    business_hours?: Record<string, any>;
    [key: string]: any; 
}

/** Full request body structure */
interface RequestBody extends UpdateFields {
    profileId?: string;
}

// --- Client Initialization ---

const dynamodb = new DynamoDBClient({ region: process.env.REGION });
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
        const parts = token.split(".");
        if (parts.length < 2) {
             return {
                statusCode: 401,
                body: JSON.stringify({ error: "Invalid token format" }),
            };
        }
        
        const payload = parts[1];
        
        // Decode the Base64URL payload
        const decodedClaims: JwtClaims = JSON.parse(
            Buffer.from(payload, "base64").toString("utf8")
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

        // Step 2: Get clinicId from API Gateway proxy path
        // Expected path: /clinic-profiles/{clinicId} or via proxy
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

        // Step 5: Confirm profile exists
        const getCommand = new GetItemCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: { S: clinicId },
                userSub: { S: userSub }
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

        // Step 6: Prepare update fields
        const expressionAttributeNames: Record<string, string> = { "#updatedAt": "updatedAt" };
        const expressionAttributeValues: Record<string, AttributeValue> = { ":updatedAt": { S: new Date().toISOString() } };
        const updateExpressions: string[] = [];

        // Process allowed fields
        for (const key of ALLOWED_FIELDS) {
            const value = updateFields[key];
            if (value !== undefined && value !== null) {
                const attrName = `#${key}`;
                const attrValue = `:${key}`;
                
                expressionAttributeNames[attrName] = key as string;
                
                // Convert JS types to DynamoDB AttributeValues
                if (typeof value === 'string') {
                    expressionAttributeValues[attrValue] = { S: value };
                } else if (typeof value === 'number') {
                    expressionAttributeValues[attrValue] = { N: String(value) };
                } else if (typeof value === 'boolean') {
                    expressionAttributeValues[attrValue] = { BOOL: value };
                } else if (Array.isArray(value) && key === 'specialties') {
                    // Assuming string set for specialties
                     const strList = value.filter(v => typeof v === 'string');
                     if (strList.length > 0) {
                        expressionAttributeValues[attrValue] = { SS: strList };
                     }
                } else if (typeof value === 'object' && key === 'business_hours') {
                    // Simple serialization for map/object types if specific structure isn't enforced,
                    // or build a Map Attribute Value. Here we use M (Map).
                    const mapAttr: Record<string, AttributeValue> = {};
                    Object.entries(value).forEach(([k, v]) => {
                        if (typeof v === 'string') mapAttr[k] = { S: v };
                        // Add more type checks if business_hours is complex
                    });
                    expressionAttributeValues[attrValue] = { M: mapAttr };
                }

                // Only add to expression if value was successfully marshalled
                if (expressionAttributeValues[attrValue]) {
                    updateExpressions.push(`${attrName} = ${attrValue}`);
                }
            }
        }

        if (updateExpressions.length === 0) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: "No valid fields provided for update" }),
            };
        }

        // Step 7: Execute Update
        const updateExpression = "SET " + updateExpressions.join(", ") + ", #updatedAt = :updatedAt";

        const updateCommand = new UpdateItemCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: {
                clinicId: { S: clinicId },
                userSub: { S: userSub }
            },
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        });

        const result = await dynamodb.send(updateCommand);

        console.info("✅ Clinic profile updated");

        return {
            statusCode: 200,
            body: JSON.stringify({
                message: "Clinic profile updated successfully",
                profileId,
                updatedAt: new Date().toISOString(),
                profile: result.Attributes, // Note: Attributes will be in DynamoDB JSON format
            }),
        };
    } catch (error) {
        console.error("❌ Error in updateClinicProfile:", error);
        const errorMessage = (error as Error).message;
        
        if (errorMessage.includes("Missing or invalid Authorization")) {
             return { statusCode: 401, body: JSON.stringify({ error: errorMessage }) };
        }

        return {
            statusCode: 500,
            body: JSON.stringify({ error: "Failed to update clinic profile", details: errorMessage }),
        };
    }
};