import {
    DynamoDBClient,
    PutItemCommand,
    PutItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";

// Assuming utils.ts contains definitions for validateToken and buildAddress
import { validateToken, buildAddress } from "./utils";

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

// ❌ REMOVED INLINE HEADERS DEFINITION
/*
type CorsHeaders = Record<string, string>;

// Shared headers for the response
const HEADERS: CorsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Content-Type": "application/json",
};
*/

// Define the expected structure for the request body
interface ClinicRequestBody {
    name: string;
    addressLine1: string;
    addressLine2?: string;
    addressLine3?: string;
    city: string;
    state: string;
    pincode: string;
    // Add other optional fields if necessary
    [key: string]: any;
}

/* ----------------- group helpers ----------------- */

/**
 * Parses Cognito user groups from the API Gateway event authorizer claims.
 * @param event The API Gateway Proxy Event.
 * @returns An array of string group names.
 */
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    const claims = event?.requestContext?.authorizer?.claims || {};
    // Check for both 'cognito:groups' and 'cognito:Groups'
    let raw: unknown = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
    
    // Original JS logic replicated for handling various raw types
    if (Array.isArray(raw)) return raw.map(String); // Ensure array of strings
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        
        // Attempt to parse if it looks like a JSON array string
        if (val.startsWith("[") && val.endsWith("]")) {
            try { 
                const arr = JSON.parse(val); 
                return Array.isArray(arr) ? arr.map(String) : []; 
            } catch (e) {
                // Ignore JSON parse error, fall through to comma separation
            }
        }
        // Fallback to comma separation
        return val.split(",").map(s => s.trim()).filter(Boolean);
    }
    return [];
}

/**
 * Normalizes a group name by converting to lowercase and removing non-alphanumeric characters.
 * @param g The group name.
 * @returns The normalized string.
 */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, ""); 

const ALLOWED_CREATORS: Set<string> = new Set(["root", "clinicadmin"]);

/**
 * Checks if the user's groups permit the creation of a clinic.
 * @param groups The user's Cognito groups.
 * @returns True if creation is allowed, otherwise false.
 */
function canCreateClinic(groups: string[]): boolean {
    const normalized: string[] = groups.map(normalize);
    const ok: boolean = normalized.some(g => ALLOWED_CREATORS.has(g));
    console.log("[auth] groups raw:", groups, "normalized:", normalized, "canCreateClinic:", ok);
    return ok;
}
/* -------------------------------------------------- */

// Define the Lambda handler function
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    // Handle CORS preflight
    if (event.httpMethod === "OPTIONS") {
        // ✅ Updated to use CORS_HEADERS
        return { statusCode: 200, headers: CORS_HEADERS, body: "{}" };
    }

    try {
        // Step 1: Authentication and Authorization
        // We cast event to 'any' here because APIGatewayProxyEvent doesn't include the Cognito claims object by default.
        const userSub: string = await validateToken(event as any);
        const groups: string[] = parseGroupsFromAuthorizer(event);

        if (!canCreateClinic(groups)) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS, // ✅ Updated to use CORS_HEADERS
                body: JSON.stringify({ error: "Only Root or Clinic Admin can create clinics" }),
            };
        }

        // Step 2: Input Validation and Parsing
        const body: ClinicRequestBody = JSON.parse(event.body || "{}");
        const { name, addressLine1, addressLine2, addressLine3, city, state, pincode } = body;

        if (!name || !addressLine1 || !city || !state || !pincode) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS, // ✅ Updated to use CORS_HEADERS
                body: JSON.stringify({
                    error: "Missing required fields: name, addressLine1, city, state, pincode",
                }),
            };
        }

        // Step 3: Prepare data
        // Assumes buildAddress is a utility that concatenates the address parts
        const address: string = buildAddress({ addressLine1, addressLine2, addressLine3, city, state, pincode });

        const clinicId: string = uuidv4();
        const timestamp: string = new Date().toISOString();

        // Determine DynamoDB attribute type for AssociatedUsers based on env var
        const assocType: string = (process.env.ASSOCIATED_USERS_TYPE || "L").toUpperCase();

        let AssociatedUsers: AttributeValue;

        if (assocType === "SS") {
            // String Set (SS)
            AssociatedUsers = { SS: [userSub] };
        } else {
            // List (L) - Default behavior, matching the original JS code's structure
            AssociatedUsers = { L: [{ S: userSub }] }; 
        }

        // Build the DynamoDB Item
        const item: Record<string, AttributeValue> = {
            clinicId:      { S: clinicId },
            name:          { S: name },
            addressLine1:  { S: addressLine1 },
            addressLine2:  { S: addressLine2 || "" },
            addressLine3:  { S: addressLine3 || "" },
            city:          { S: (city || "").trim() },
            state:         { S: (state || "").trim() },
            pincode:       { S: (pincode || "").trim() },
            address:       { S: address },
            createdBy:     { S: userSub },
            createdAt:     { S: timestamp },
            updatedAt:     { S: timestamp },
            AssociatedUsers, // <- ensure creator is included on create
        };

        console.log("[create-clinic] PutItem item:", JSON.stringify(item, null, 2));

        // Step 4: Write to DynamoDB
        const putItemInput: PutItemCommandInput = {
            TableName: process.env.CLINICS_TABLE, // e.g. "DentiPal-Clinics"
            Item: item,
            ConditionExpression: "attribute_not_exists(clinicId)", // don't overwrite if exists
        };

        await dynamoClient.send(new PutItemCommand(putItemInput));

        // Step 5: Return Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS, // ✅ Updated to use CORS_HEADERS
            body: JSON.stringify({
                status: "success",
                message: "Clinic created successfully",
                clinic: {
                    clinicId,
                    name,
                    addressLine1,
                    addressLine2: addressLine2 || "",
                    addressLine3: addressLine3 || "",
                    city: (city || "").trim(),
                    state: (state || "").trim(),
                    pincode: (pincode || "").trim(),
                    address,
                    createdBy: userSub,
                    createdAt: timestamp,
                    updatedAt: timestamp,
                    // Note: The response uses an array for associatedUsers, 
                    // regardless of whether the DB stored it as L or SS.
                    associatedUsers: [userSub], 
                },
            }),
        };
    } catch (error) {
        // Step 6: Handle Errors
        const err = error as Error & { message?: string }; // Cast for message property access
        console.error("Error creating clinic:", err);
        return {
            statusCode: 400,
            headers: CORS_HEADERS, // ✅ Updated to use CORS_HEADERS
            body: JSON.stringify({
                error: "Failed to create clinic",
                details: err.message || String(error),
            }),
        };
    }
};

exports.handler = handler;