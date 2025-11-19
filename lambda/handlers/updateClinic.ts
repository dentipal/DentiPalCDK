import { DynamoDBClient, UpdateItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { validateToken, hasClinicAccess, buildAddress } from "./utils"; 
// Assuming utils.ts exports validateToken, hasClinicAccess, and buildAddress

// --- Type Definitions ---

/** Defines the claims structure expected from the API Gateway Authorizer */
interface AuthorizerClaims {
    "cognito:groups"?: string | string[];
    "cognito:Groups"?: string | string[];
    [key: string]: any;
}

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

/** ----------------- NEW: robust groups parsing + helpers ----------------- */

/**
 * Robustly parses Cognito groups from different locations/formats in the authorizer claims.
 */
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    const claims: AuthorizerClaims = event?.requestContext?.authorizer?.claims || {};
    
    let raw: string | string[] = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
    
    if (Array.isArray(raw)) return raw.map(String);
    
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        
        // Handle JSON array string
        if (val.startsWith("[") && val.endsWith("]")) {
            try { 
                const arr = JSON.parse(val); 
                return Array.isArray(arr) ? arr.map(String) : []; 
            } catch {
                // Fallthrough to comma-separated
            }
        }
        
        // Handle comma-separated string
        return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    
    return [];
}

/** Normalizes a group string for comparison (lowercase, remove non-alphanumeric) */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Set of normalized group names allowed to perform updates */
const ALLOWED_UPDATERS: ReadonlySet<string> = new Set(["root", "clinicadmin"]);

/** ----------------------------------------------------------------------- */

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 1. Authentication
        // Assuming validateToken returns userSub (string) or throws if invalid
        const userSub: string = await validateToken(event); 

        // 2. Group Authorization Check (Root, ClinicAdmin)
        const rawGroups: string[] = parseGroupsFromAuthorizer(event);
        const normalized: string[] = rawGroups.map(normalize);
        const isRootGroup: boolean = normalized.includes("root");
        
        const isAllowedGroup: boolean = normalized.some(g => ALLOWED_UPDATERS.has(g));
        
        if (!isAllowedGroup) {
            return { 
                statusCode: 403, 
                body: JSON.stringify({ error: "Access denied: only Root or ClinicAdmin can update clinics" }) 
            };
        }

        // 3. Extract Clinic ID
        let clinicId: string | undefined = event.pathParameters?.clinicId || event.pathParameters?.proxy;
        console.log("Extracted clinicId:", clinicId);

        if (!clinicId) {
            return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required in path parameters" }) };
        }

        // 4. Clinic-Scoped Access Check
        // Root bypasses clinic-scoped check; ClinicAdmin must have clinic access
        if (!isRootGroup) {
            // hasClinicAccess should take userSub, clinicId, and requiredLevel
            const hasAccess: boolean = await hasClinicAccess(userSub, clinicId, "ClinicAdmin");
            if (!hasAccess) {
                return { statusCode: 403, body: JSON.stringify({ error: "Access denied to update clinic" }) };
            }
        }

        // 5. Parse and Prepare Update Data
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
            return { statusCode: 400, body: JSON.stringify({ error: "No fields to update" }) };
        }

        if (!CLINICS_TABLE) {
             console.error("Environment variable CLINICS_TABLE is not set.");
             return { statusCode: 500, body: JSON.stringify({ error: "Server configuration error." }) };
        }

        // 6. Execute DynamoDB Update
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
        
        // 7. Success Response
        return {
            statusCode: 200,
            body: JSON.stringify({ status: "success", message: "Clinic updated successfully" }),
        };
    } catch (err) {
        const error = err as Error;
        console.error("Error updating clinic:", error);
        
        // Provide more detailed error response in production/development
        return { 
            statusCode: 500, 
            body: JSON.stringify({ error: `Failed to update clinic: ${error.message}` }) 
        };
    }
};