import {
    DynamoDBClient,
    PutItemCommand,
    PutItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { v4 as uuidv4 } from "uuid";

// Assuming utils.ts contains definitions for extractUserFromBearerToken, verifyToken and buildAddress
import { extractUserFromBearerToken, buildAddress, verifyToken } from "./utils";

// ✅ ADDED THIS LINE:
import { CORS_HEADERS } from "./corsHeaders";

// Initialize the DynamoDB client
const dynamoClient = new DynamoDBClient({ region: process.env.REGION });



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
        // Step 1: Authentication and Authorization - Extract access token + merge with authorizer
        let userSub: string | undefined;
        let groups: string[] = [];

        const authHeader = event.headers?.Authorization || event.headers?.authorization;

        // Try extracting groups from the bearer token (robust decoder)
        try {
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            if (Array.isArray(userInfo.groups) && userInfo.groups.length) {
                groups = groups.concat(userInfo.groups);
            }
            console.log('[auth] token-derived userSub:', userSub, 'groups:', JSON.stringify(userInfo.groups));
        } catch (tokenErr: any) {
            console.log('[auth] token decode failed:', tokenErr?.message || tokenErr);
        }

        // Also try to read groups from the API Gateway authorizer (if present)
        try {
            const authInfo = await verifyToken(event);
            if (authInfo) {
                userSub = userSub || authInfo.sub;
                if (Array.isArray(authInfo.groups) && authInfo.groups.length) {
                    groups = groups.concat(authInfo.groups);
                }
                console.log('[auth] authorizer-derived userSub:', authInfo.sub, 'groups:', JSON.stringify(authInfo.groups));
            }
        } catch (authErr: any) {
            console.log('[auth] verifyToken error:', authErr?.message || authErr);
        }

        // Normalize and dedupe groups
        groups = Array.from(new Set(groups.map(g => (g || '').toString())));
        console.log("[auth] final userSub:", userSub, "final groups:", groups);

        if (!userSub) {
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({ error: 'User not authenticated' })
            };
        }

        if (!canCreateClinic(groups)) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Forbidden",
                    message: "Only Root or Clinic Admin users can create clinics",
                    statusCode: 403,
                    groups: groups,
                    timestamp: new Date().toISOString(),
                }),
            };
        }

        // Step 2: Input Validation and Parsing
        const body: ClinicRequestBody = JSON.parse(event.body || "{}");
        const { name, addressLine1, addressLine2, addressLine3, city, state, pincode } = body;

        if (!name || !addressLine1 || !city || !state || !pincode) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Bad Request",
                    message: "Missing required fields",
                    requiredFields: ["name","addressLine1","city", "state", "pincode"],
                    statusCode: 400,
                    timestamp: new Date().toISOString(),
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
            statusCode: 201,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                status: "success",
                statusCode: 201,
                message: "Clinic created successfully",
                data: {
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
                    associatedUsers: [userSub],
                },
            }),
        };
    } catch (error) {
        // Step 6: Handle Errors
        const err = error as Error & { name?: string; message?: string };
        console.error("Error creating clinic:", err);
        
        let statusCode = 500;
        let errorMessage = "Internal Server Error";
        let details: any = {};

        if (err.name === "ConditionalCheckFailedException") {
            statusCode = 409;
            errorMessage = "Conflict";
            details = { message: "Clinic with this ID already exists" };
        } else if (err.name === "ValidationException") {
            statusCode = 400;
            errorMessage = "Bad Request";
            details = { message: "Invalid request parameters" };
        } else if (err.name === "ResourceNotFoundException") {
            statusCode = 404;
            errorMessage = "Not Found";
            details = { message: "DynamoDB table not found" };
        } else if (err.name === "AccessDenied") {
            statusCode = 403;
            errorMessage = "Forbidden";
            details = { message: "Access denied to DynamoDB resource" };
        } else if (err.name === "ServiceUnavailableException") {
            statusCode = 503;
            errorMessage = "Service Unavailable";
            details = { message: "DynamoDB service temporarily unavailable" };
        } else {
            statusCode = 500;
            errorMessage = "Internal Server Error";
            details = { message: err.message || "An unexpected error occurred" };
        }

        return {
            statusCode,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: errorMessage,
                statusCode,
                details,
                timestamp: new Date().toISOString(),
            }),
        };
    }
};

exports.handler = handler;