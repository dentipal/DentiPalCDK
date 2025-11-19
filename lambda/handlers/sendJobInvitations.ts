import {
    DynamoDBClient,
    QueryCommand,
    BatchGetItemCommand,
    PutItemCommand,
    AttributeValue,
    DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    APIGatewayProxyEvent,
} from "aws-lambda";
import { validateToken } from "./utils"; // Assuming ./utils exports validateToken
import { v4 as uuidv4 } from "uuid"; // Assuming uuid package is installed

// --- Type Definitions ---

/** Defines the expected structure of the request body payload. */
interface InvitationPayload {
    professionalUserSubs: string[];
    invitationMessage?: string;
    urgency?: string;
    customNotes?: string;
}

/** Define a generalized structure for DynamoDB Items */
type DynamoDBItem = { [key: string]: AttributeValue | undefined };

/** Minimal structure for a Job Posting Item (dynamoDB format) */
interface JobItem extends DynamoDBItem {
    clinicId?: AttributeValue;
    professional_role?: AttributeValue;
    job_type?: AttributeValue;
}

/** Minimal structure for a Professional Profile Item (dynamoDB format) */
interface ProfessionalItem extends DynamoDBItem {
    userSub?: AttributeValue;
    full_name?: AttributeValue;
    role?: AttributeValue;
}

/** Defines the result structure for a single successful invitation */
interface InvitationResult {
    invitationId: string;
    professionalUserSub: string;
    status: "sent";
}

/** Defines the result structure for a single failed invitation */
interface InvitationError {
    professionalUserSub: string;
    error: string;
}

/** Standard response format for API Gateway V2 Lambda integration */
type HandlerResponse = APIGatewayProxyResultV2;


// --- Constants and Initialization ---

// Use non-null assertion (!) as we expect these environment variables to be set.
const REGION: string = process.env.REGION!;
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!;
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
const JOB_INVITATIONS_TABLE: string = process.env.JOB_INVITATIONS_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);

// Get CORS Origin from environment variable or default to localhost
const ORIGIN: string = process.env.CORS_ORIGIN || "http://localhost:5173";
const CORS_HEADERS = {
    "Access-Control-Allow-Origin": ORIGIN,
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
};

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): Promise<HandlerResponse> => {
    try {
        const headers = CORS_HEADERS;
        
        // Handle CORS preflight
        const method = (event as APIGatewayProxyEventV2)?.requestContext?.http?.method || (event as APIGatewayProxyEvent)?.httpMethod;
        if (method === "OPTIONS") {
            return { statusCode: 200, headers, body: "" };
        }

        // 1. Authentication
        // Casting event as 'any' since validateToken might be designed for V1 or V2 events interchangeably.
        const userSub: string = await validateToken(event as any); 
        console.log("Authenticated clinic userSub:", userSub);

        // 2. Path Parsing (Extract jobId)
        // Using `pathParameters.proxy` and `path` for compatibility with common API Gateway setups
        const fullPath: string = (event.pathParameters?.proxy as string) || (event.path || "");
        const pathParts: string[] = fullPath.split("/");
        
        // Find "jobs" in path and take the next element as jobId
        const jobsIndex = pathParts.indexOf("jobs");
        const jobId: string | null = jobsIndex !== -1 && pathParts.length > jobsIndex + 1 ? pathParts[jobsIndex + 1] : null;

        if (!jobId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "jobId is required in path, e.g., /jobs/{jobId}/invite" }),
            };
        }

        // 3. Request Body Validation
        const invitationData: InvitationPayload = JSON.parse(event.body || "{}");
        const professionalUserSubs: string[] = invitationData.professionalUserSubs || [];

        if (!Array.isArray(professionalUserSubs) || professionalUserSubs.length === 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "professionalUserSubs must be a non-empty array of IDs" }),
            };
        }

        if (professionalUserSubs.length > 50) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "Maximum 50 professionals can be invited at once" }),
            };
        }

        // 4. Fetch Job Details
        const jobQuery = await dynamodb.send(new QueryCommand({
            TableName: JOB_POSTINGS_TABLE,
            IndexName: "jobId-index", // Assuming this is the GSI name
            KeyConditionExpression: "jobId = :jid",
            ExpressionAttributeValues: { ":jid": { S: jobId } },
            Limit: 1,
        }));

        const job: JobItem | undefined = jobQuery.Items?.[0] as JobItem | undefined;
        
        if (!job) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Job not found or access denied" }),
            };
        }

        const clinicId: string | undefined = job.clinicId?.S;
        const jobRole: string = job.professional_role?.S || "";

        if (!clinicId) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: "clinicId not found in job posting" }),
            };
        }

        // 5. Batch Get Professional Profiles
        const requestItems = {
            [PROFESSIONAL_PROFILES_TABLE]: {
                // Map the string array of subs to the required DynamoDB Key format
                Keys: professionalUserSubs.map((sub) => ({ userSub: { S: sub } })),
            },
        };

        const professionalsResult = await dynamodb.send(new BatchGetItemCommand({ RequestItems: requestItems }));
        
        const existingProfessionals: ProfessionalItem[] = (professionalsResult.Responses?.[PROFESSIONAL_PROFILES_TABLE] as ProfessionalItem[]) || [];
        
        const existingUserSubs: string[] = existingProfessionals
            .map((p) => p.userSub?.S)
            .filter((sub): sub is string => !!sub); // Filter out null/undefined

        const invalidUserSubs: string[] = professionalUserSubs.filter((sub) => !existingUserSubs.includes(sub));

        if (invalidUserSubs.length > 0) {
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({ error: `Invalid professional IDs: ${invalidUserSubs.join(", ")}` }),
            };
        }

        // 6. Role Compatibility Check
        const incompatibleProfessionals: ProfessionalItem[] = existingProfessionals.filter(
            (p) =>
                // Check if professional role is NOT the job role
                (p.role?.S !== jobRole) &&
                // AND the job role is NOT the dual role exception
                (jobRole !== "dual_role_front_da") &&
                // AND the professional's role is NOT the dual role exception
                (p.role?.S !== "dual_role_front_da")
        );

        if (incompatibleProfessionals.length > 0) {
            const names: string[] = incompatibleProfessionals.map(
                (p) => `${p.full_name?.S || "Unknown"} (${p.role?.S || "Unknown role"})`
            );
            return {
                statusCode: 400,
                headers,
                body: JSON.stringify({
                    error: `Role mismatch for professionals: ${names.join(", ")}. Job requires: ${jobRole}`,
                }),
            };
        }

        // 7. Send Invitations (PutItem in a loop)
        const timestamp: string = new Date().toISOString();
        const invitationResults: InvitationResult[] = [];
        const errors: InvitationError[] = [];

        for (const profSub of professionalUserSubs) {
            try {
                const invitationId: string = uuidv4();
                
                // Note: DynamoDB PutItem requires all AttributeValues to be defined with type (S, N, BOOL, etc.)
                const invitationItem: DynamoDBItem = {
                    invitationId: { S: invitationId },
                    jobId: { S: jobId },
                    professionalUserSub: { S: profSub },
                    clinicUserSub: { S: userSub },
                    clinicId: { S: clinicId },
                    invitationStatus: { S: "sent" },
                    sentAt: { S: timestamp },
                    updatedAt: { S: timestamp },
                    invitationMessage: {
                        S: invitationData.invitationMessage || "You have been invited to apply for this position.",
                    },
                    urgency: { S: invitationData.urgency || "medium" },
                    customNotes: { S: invitationData.customNotes || "" },
                    resent: { BOOL: false },
                    resentCount: { N: "0" },
                };

                await dynamodb.send(
                    new PutItemCommand({
                        TableName: JOB_INVITATIONS_TABLE,
                        Item: invitationItem,
                    })
                );

                invitationResults.push({
                    invitationId,
                    professionalUserSub: profSub,
                    status: "sent",
                });
            } catch (err) {
                console.error(`Failed to invite ${profSub}:`, err);
                errors.push({ professionalUserSub: profSub, error: "Failed to send invitation" });
            }
        }

        // 8. Prepare Final Response
        const professionalDetails = existingProfessionals.map((p) => ({
            userSub: p.userSub?.S,
            full_name: p.full_name?.S || "Unknown",
            role: p.role?.S || "Unknown",
        }));

        return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
                message: "Invitations processed successfully",
                jobId,
                jobType: job.job_type?.S || "unknown",
                jobRole,
                totalInvited: invitationResults.length,
                successful: invitationResults,
                errors,
                invitationDetails: {
                    message: invitationData.invitationMessage || "You have been invited to apply for this position.",
                    urgency: invitationData.urgency || "medium",
                    sentAt: timestamp,
                },
                professionals: professionalDetails,
            }),
        };
    } catch (error) {
        console.error("Fatal error in Lambda:", error);
        const errorMessage: string = (error as Error).message || "Internal Server Error";
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};