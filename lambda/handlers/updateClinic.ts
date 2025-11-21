import { DynamoDBClient, UpdateItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// ✅ UPDATE: Added extractUserFromBearerToken
import { hasClinicAccess, buildAddress, AccessLevel, extractUserFromBearerToken } from "./utils"; 
// Import shared CORS headers
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

/** Defines the structure of the request body for the clinic update */
interface UpdateClinicBody {
    name?: string;
    addressLine1?: string;
    addressLine2?: string;
    addressLine3?: string;
    city?: string;
    state?: string;
    pincode?: string;
}

// --- Client Initialization ---

const REGION: string = process.env.REGION || "us-east-1";
const CLINICS_TABLE: string | undefined = process.env.CLINICS_TABLE;

const dynamoClient = new DynamoDBClient({ region: REGION });

// --- Helpers ---

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});

const getMethod = (e: APIGatewayProxyEvent): string =>
    // Check httpMethod (v1) or requestContext.http.method (v2)
    e?.httpMethod || (e?.requestContext as any)?.http?.method || "GET";

/** ----------------- NEW: robust groups parsing + helpers ----------------- */

/** Normalizes a group string for comparison (lowercase, remove non-alphanumeric) */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Set of normalized group names allowed to perform updates */
const ALLOWED_UPDATERS: ReadonlySet<string> = new Set(["root", "clinicadmin"]);

/** ----------------------------------------------------------------------- */

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method = getMethod(event);

    // 1. CORS Preflight
    if (method === "OPTIONS") {
        return { statusCode: 200, headers: CORS_HEADERS, body: "" };
    }

    try {
        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        const groups = userInfo.groups || [];

        // 3. Group Authorization Check (Root, ClinicAdmin)
        const normalized: string[] = groups.map(normalize);
        const isRootGroup: boolean = normalized.includes("root");
        
        const isAllowedGroup: boolean = normalized.some(g => ALLOWED_UPDATERS.has(g));
        
        if (!isAllowedGroup) {
            return json(403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Access denied to update clinics",
                details: { requiredGroups: ["Root", "ClinicAdmin"] },
                timestamp: new Date().toISOString()
            });
        }

        // 4. Extract Clinic ID
        let clinicId: string | undefined = event.pathParameters?.clinicId || event.pathParameters?.proxy;
        console.log("Extracted clinicId:", clinicId);

        if (!clinicId) {
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Clinic ID is required",
                details: { pathFormat: "PUT /clinics/{clinicId}" },
                timestamp: new Date().toISOString()
            });
        }

        // 5. Clinic-Scoped Access Check
        // Root bypasses clinic-scoped check; ClinicAdmin must have clinic access
        if (!isRootGroup) {
            const hasAccess: boolean = await hasClinicAccess(userSub, clinicId, "ClinicAdmin" as AccessLevel);
            
            if (!hasAccess) {
                return json(403, {
                    error: "Forbidden",
                    statusCode: 403,
                    message: "Access denied to update this clinic",
                    details: { clinicId: clinicId },
                    timestamp: new Date().toISOString()
                });
            }
        }

        // 6. Parse and Prepare Update Data
        const body: UpdateClinicBody = JSON.parse(event.body || '{}');
        const { name, addressLine1, addressLine2, addressLine3, city, state, pincode } = body;
        
        const updateExpression: string[] = [];
        const expressionAttributeValues: { [key: string]: AttributeValue } = {};
        const expressionAttributeNames: { [key: string]: string } = {};

        if (name) {
            updateExpression.push("#name = :name");
            expressionAttributeValues[":name"] = { S: name };
            expressionAttributeNames["#name"] = "name"; // Alias for reserved word
        }

        // Check if any address component is present
        if (addressLine1 || addressLine2 || addressLine3 || city || state || pincode) {
            const address: string = buildAddress({ 
                addressLine1: addressLine1 || "", 
                addressLine2: addressLine2 || undefined, 
                addressLine3: addressLine3 || undefined, 
                city: city || "", 
                state: state || "", 
                pincode: pincode || "" 
            });
            updateExpression.push("address = :address");
            expressionAttributeValues[":address"] = { S: address };
        }

        // Always update timestamp
        const updatedAtISO = new Date().toISOString();
        updateExpression.push("updatedAt = :updatedAt");
        expressionAttributeValues[":updatedAt"] = { S: updatedAtISO };

        // Check if only timestamp is being updated
        // If we only have 1 item in the array, it's just 'updatedAt'
        if (updateExpression.length === 1 && updateExpression[0].includes("updatedAt")) { 
            return json(400, {
                error: "Bad Request",
                statusCode: 400,
                message: "No fields to update",
                details: { availableFields: ["name", "addressLine1", "addressLine2", "addressLine3", "city", "state", "pincode"] },
                timestamp: new Date().toISOString()
            });
        }

        if (!CLINICS_TABLE) {
             console.error("Environment variable CLINICS_TABLE is not set.");
             return json(500, {
                 error: "Internal Server Error",
                 statusCode: 500,
                 message: "Server configuration error",
                 details: { missingConfig: "CLINICS_TABLE" },
                 timestamp: new Date().toISOString()
             });
        }

        // 7. Execute DynamoDB Update
        const command = new UpdateItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            UpdateExpression: `SET ${updateExpression.join(", ")}`,
            ExpressionAttributeValues: expressionAttributeValues,
            // Only include ExpressionAttributeNames if needed (i.e., if '#name' was used)
            ExpressionAttributeNames: Object.keys(expressionAttributeNames).length > 0 ? expressionAttributeNames : undefined,
            ConditionExpression: "attribute_exists(clinicId)", // Ensure item exists
        });

        await dynamoClient.send(command);
        
        // 8. Success Response
        return json(200, {
            status: "success",
            statusCode: 200,
            message: "Clinic updated successfully",
            data: { clinicId },
            timestamp: new Date().toISOString()
        });
        
    } catch (err) {
        const error = err as Error;
        console.error("Error updating clinic:", error);
        
        // ✅ Check for Auth errors and return 401
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return json(401, {
                error: "Unauthorized",
                details: error.message
            });
        }

        return json(500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to update clinic",
            details: { reason: error.message },
            timestamp: new Date().toISOString()
        });
    }
};