// Imports from AWS SDK
import { 
    DynamoDBClient, 
    UpdateItemCommand, 
    UpdateItemCommandInput,
    DynamoDBClientConfig 
} from "@aws-sdk/client-dynamodb";
// Imports for AWS Lambda types (assuming API Gateway V2 or similar)
import { 
    APIGatewayProxyEventV2, 
    APIGatewayProxyResultV2 
} from "aws-lambda"; 

// Import the utility function. You'll need to create a `utils.ts` file 
// with the correct export for `validateToken`.
// import { validateToken } from "./utils"; // <--- Uncomment this line

// --- Type Definitions ---

// Define the shape of the expected utility function
interface TokenValidator {
    (event: APIGatewayProxyEventV2): Promise<string>; // Returns the userSub
}

// Placeholder for the external utility function (replace with actual import)
const validateToken: TokenValidator = (event: APIGatewayProxyEventV2): Promise<string> => {
    // NOTE: This placeholder assumes validateToken is defined and correctly 
    // imports the external function. You must ensure `validateToken` is 
    // exported from `./utils` and is correctly implemented.
    // For now, returning a mock user sub. Remove this mock and 
    // uncomment the real import when deploying.
    return Promise.resolve("mock-user-sub-from-token"); 
};

/** Standard response format for API Gateway V2 Lambda integration */
type HandlerResponse = APIGatewayProxyResultV2;

/** Interface for the expected structure of Cognito claims */
interface CognitoClaims {
    "cognito:groups"?: string | string[];
    "cognito:Groups"?: string | string[];
    [key: string]: any;
}

// --- Constants and Initialization ---

// Use non-null assertion (!) as we expect this to be set in the Lambda environment
const REGION: string = process.env.REGION!; 

// AWS SDK Client
const clientConfig: DynamoDBClientConfig = { region: REGION };
const dynamodb = new DynamoDBClient(clientConfig);

// Reusable CORS headers
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST"
};

const ALLOWED_GROUPS = new Set<string>(["root", "clinicadmin", "clinicmanager"]);


/* ------------------------------------------------------------------------- */
/** * Robustly parses user groups from the Cognito Authorizer claims in the event. 
 * Handles string, array, and JSON string representations.
 */
function parseGroupsFromAuthorizer(event: APIGatewayProxyEventV2): string[] {
    const claims: CognitoClaims = event?.requestContext?.authorizer?.claims || {};
    let raw: string | string[] = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";

    if (Array.isArray(raw)) return raw;
    
    if (typeof raw === "string") {
        const val = raw.trim();
        if (!val) return [];
        
        // Attempt to parse as JSON array
        if (val.startsWith("[") && val.endsWith("]")) {
            try {
                const arr = JSON.parse(val);
                if (Array.isArray(arr)) {
                    // Filter out any non-string elements just in case
                    return arr.filter((item): item is string => typeof item === 'string'); 
                }
            } catch (e) {
                // If JSON.parse fails, fall through to comma-separated logic
                console.warn("Failed to parse groups as JSON array:", e);
            }
        }
        
        // Fallback to comma-separated string logic
        return val.split(",")
                  .map(s => s.trim())
                  .filter(Boolean);
    }
    
    return [];
}

/** Converts a group name to a normalized, lowercase, alphanumeric string. */
const normalize = (g: string): string => g.toLowerCase().replace(/[^a-z0-9]/g, "");
/* ------------------------------------------------------------------------- */

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2): Promise<HandlerResponse> => {
    try {
        // Handle preflight OPTIONS request
        if (event.requestContext.http.method === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // 1. Extract and Validate Path Parameters (clinicId and jobId)
        // Using event.rawPath for reliability in V2 payload format
        const fullPath = event.rawPath || ""; 
        // Regex to match: /<clinicId>/reject/<jobId>
        const match = fullPath.match(/\/([^/]+)\/reject\/([^/]+)/);

        const clinicId: string | undefined = match?.[1];
        const jobId: string | undefined = match?.[2];

        if (!clinicId || !jobId) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ 
                    error: "Both clinicId and jobId are required in the path (e.g., /123/reject/456)" 
                })
            };
        }

        // 2. Validate Token (Authentication)
        // Assume validateToken throws an error on failure, which is caught below
        await validateToken(event); 

        // 3. Group Authorization
        const rawGroups: string[] = parseGroupsFromAuthorizer(event);
        const normalizedGroups: string[] = rawGroups.map(normalize);
        
        const isAllowed: boolean = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));

        if (!isAllowed) {
            return {
                statusCode: 403,
                headers: CORS_HEADERS,
                body: JSON.stringify({ 
                    error: "Access denied: insufficient permissions to reject applications. Requires one of: root, clinicadmin, clinicmanager." 
                })
            };
        }

        // 4. Extract and Validate Body Parameter (professionalUserSub)
        const body: { professionalUserSub?: string } = JSON.parse(event.body || "{}");
        const professionalUserSub: string | undefined = body.professionalUserSub;

        if (!professionalUserSub) {
            return {
                statusCode: 400,
                headers: CORS_HEADERS,
                body: JSON.stringify({ 
                    error: "professionalUserSub is required in the request body" 
                })
            };
        }

        // 5. Update DynamoDB
        const updateParams: UpdateItemCommandInput = {
            TableName: "DentiPal-JobApplications", // Assuming table name is constant
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            },
            UpdateExpression: "SET applicationStatus = :rejected",
            ExpressionAttributeValues: {
                ":rejected": { S: "rejected" }
            }
        };

        const updateCommand = new UpdateItemCommand(updateParams);
        await dynamodb.send(updateCommand);

        console.log(`Application for job ${jobId} by professional ${professionalUserSub} rejected successfully.`);

        // 6. Success Response
        return {
            statusCode: 200,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                message: `Job application for job ${jobId} by professional ${professionalUserSub} has been rejected successfully`
            })
        };

    } catch (error) {
        console.error("❌ Error rejecting job application:", error);
        
        // Ensure error is treated as an Error object to access message
        const errorMessage = (error as Error).message;

        // 7. Error Response
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({
                error: "Failed to reject job application. Please try again.",
                details: errorMessage || "An unknown error occurred"
            })
        };
    }
};

// Export the handler function
// Note: In modern Node.js environments (like Lambda), using `export const handler` is often enough, 
// but keeping `exports.handler = handler;` for compatibility if needed.
// exports.handler = handler;