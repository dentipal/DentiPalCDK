// Imports from AWS SDK
import { 
    DynamoDBClient, 
    UpdateItemCommand, 
    UpdateItemCommandInput,
    DynamoDBClientConfig 
} from "@aws-sdk/client-dynamodb";
// Imports for AWS Lambda types (Switching to V1 to match project consistency and fix type errors)
import { 
    APIGatewayProxyEvent, 
    APIGatewayProxyResult 
} from "aws-lambda"; 
import { validateToken } from "./utils";

// --- Type Definitions ---

/** Standard response format for API Gateway Lambda integration */
type HandlerResponse = APIGatewayProxyResult;

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
function parseGroupsFromAuthorizer(event: APIGatewayProxyEvent): string[] {
    // FIX: Cast requestContext to 'any' to avoid type errors if the definition is strict
    const claims: CognitoClaims = (event.requestContext as any)?.authorizer?.claims || {};
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
export const handler = async (event: APIGatewayProxyEvent): Promise<HandlerResponse> => {
    try {
        // FIX: Cast requestContext to 'any' to allow access to 'http' property which is specific to HTTP API (v2)
        const method = event.httpMethod || (event.requestContext as any)?.http?.method;

        // Handle preflight OPTIONS request
        if (method === "OPTIONS") {
            return { statusCode: 200, headers: CORS_HEADERS, body: "" };
        }

        // 1. Extract and Validate Path Parameters (clinicId and jobId)
        // Support both direct path parameters and proxy path
        // /<clinicId>/reject/<jobId>
        let clinicId = event.pathParameters?.clinicId;
        let jobId = event.pathParameters?.jobId;

        // Fallback to parsing path/proxy if specific params aren't mapped
        if ((!clinicId || !jobId) && (event.path || event.pathParameters?.proxy)) {
             const rawPath = event.path || event.pathParameters?.proxy || "";
             const match = rawPath.match(/\/([^/]+)\/reject\/([^/]+)/);
             if (match) {
                 clinicId = match[1];
                 jobId = match[2];
             }
        }

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
        // Cast event to any to ensure compatibility
        await validateToken(event as any); 

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
            TableName: "DentiPal-JobApplications", // Assuming table name is constant, consider using process.env.JOB_APPLICATIONS_TABLE
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