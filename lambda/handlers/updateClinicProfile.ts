import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Buffer } from 'buffer';
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

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

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj)
});

// --- Handler ---

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    console.info("🔧 Starting updateClinicProfile handler");

    // CORS Preflight
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        if (!CLINIC_PROFILES_TABLE) {
            console.error("❌ CLINIC_PROFILES_TABLE environment variable is not set.");
            return json(500, { error: "Server configuration error: Table not defined." });
        }

        // Step 1: Decode JWT token manually
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            console.error("❌ Missing or invalid Authorization header");
            return json(401, { error: "Missing or invalid Authorization header" });
        }

        const token = authHeader.split(" ")[1];
        const parts = token.split(".");
        if (parts.length < 2) {
             return json(401, { error: "Invalid token format" });
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
        // Extract the last segment as clinicId
        const clinicId: string | undefined = pathParts[pathParts.length - 1];

        console.info("📦 Decoded claims:", decodedClaims);
        console.info("🏥 Extracted clinicId from path:", clinicId);

        if (!clinicId || !userSub) {
            console.error("❌ Missing clinicId or userSub");
            return json(401, { error: "Missing clinicId or userSub" });
        }

        // Step 3: Verify user is clinic or Root
        const isClinicUser = userType.toLowerCase() === "clinic" || groups.includes("clinic");
        const isRootUser = groups.includes("Root");

        if (!isClinicUser && !isRootUser) {
            console.warn("🚫 Unauthorized userType for profile update:", userType);
            return json(403, { error: "Access denied – only clinic users can update clinic profiles" });
        }

        // Step 4: Parse body and validate
        const requestBody: RequestBody = JSON.parse(event.body || "{}");
        const { profileId, ...updateFields } = requestBody;

        if (!profileId) {
            console.warn("⚠️ profileId missing in request body");
            return json(400, { error: "profileId is required" });
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
            return json(404, { error: "Clinic profile not found" });
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
                    // Simple serialization for map/object types using Map Attribute Value
                    const mapAttr: Record<string, AttributeValue> = {};
                    Object.entries(value).forEach(([k, v]) => {
                        if (typeof v === 'string') mapAttr[k] = { S: v };
                        // Add logic here if nested objects are needed in business_hours
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
            return json(400, { error: "No valid fields provided for update" });
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

        return json(200, {
            message: "Clinic profile updated successfully",
            profileId,
            updatedAt: new Date().toISOString(),
            profile: result.Attributes,
        });
    } catch (error: any) {
        console.error("❌ Error in updateClinicProfile:", error);
        const errorMessage = (error as Error).message;

        if (errorMessage.includes("Missing or invalid Authorization")) {
             return json(401, { error: errorMessage });
        }

        return json(500, { error: "Failed to update clinic profile", details: errorMessage });
    }
};