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
import { extractUserFromBearerToken } from "./utils"; 
import { v4 as uuidv4 } from "uuid"; 
import { CORS_HEADERS } from "./corsHeaders";

// --- Type Definitions ---

interface InvitationPayload {
    professionalUserSubs: string[];
    invitationMessage?: string;
    urgency?: string;
    customNotes?: string;
}

type DynamoDBItem = Record<string, AttributeValue>;

interface JobItem {
    clinicId?: AttributeValue;
    professional_role?: AttributeValue;
    job_type?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

interface ProfessionalItem {
    userSub?: AttributeValue;
    full_name?: AttributeValue;
    role?: AttributeValue;
    [key: string]: AttributeValue | undefined;
}

interface InvitationResult {
    invitationId: string;
    professionalUserSub: string;
    status: "sent";
}

interface InvitationError {
    professionalUserSub: string;
    error: string;
}

type HandlerResponse = APIGatewayProxyResultV2;

// --- Constants and Initialization ---

const REGION: string = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!;
const PROFESSIONAL_PROFILES_TABLE: string = process.env.PROFESSIONAL_PROFILES_TABLE!;
const JOB_INVITATIONS_TABLE: string = process.env.JOB_INVITATIONS_TABLE!;

// 🛑 FIX: Updated default to match your CDK definition ('jobId-index-1')
const JOB_ID_INDEX: string = process.env.JOB_ID_INDEX || "jobId-index-1";

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): Promise<HandlerResponse> => {
    try {
        const headers = CORS_HEADERS;
        
        // Handle CORS preflight
        const method = (event as APIGatewayProxyEventV2)?.requestContext?.http?.method || (event as APIGatewayProxyEvent)?.httpMethod;
        if (method === "OPTIONS") {
            return { statusCode: 200, headers, body: "" };
        }

        // --- ✅ STEP 1: AUTHENTICATION (AccessToken) ---
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub; 
        
        console.log("Authenticated clinic userSub:", userSub);

        // 2. Path Parsing (Extract jobId)
        const v1Path = (event as APIGatewayProxyEvent).path;
        const v2Path = (event as APIGatewayProxyEventV2).rawPath;
        
        const fullPath: string = (event.pathParameters?.proxy as string) || (v1Path || v2Path || "");
        const pathParts: string[] = fullPath.split("/");
        
        // Robustly find "jobs" in path and take the next element as jobId
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
            IndexName: JOB_ID_INDEX, // Now matches 'jobId-index-1'
            KeyConditionExpression: "jobId = :jid",
            ExpressionAttributeValues: { ":jid": { S: jobId } },
            Limit: 1,
        }));

        const job: JobItem | undefined = jobQuery.Items?.[0] as JobItem | undefined;
        
        if (!job) {
            return {
                statusCode: 404,
                headers,
                body: JSON.stringify({ error: "Job not found or access denied." }),
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
                Keys: professionalUserSubs.map((sub) => ({ userSub: { S: sub } })),
            },
        };

        const professionalsResult = await dynamodb.send(new BatchGetItemCommand({ RequestItems: requestItems }));
        
        const existingProfessionals: ProfessionalItem[] = (professionalsResult.Responses?.[PROFESSIONAL_PROFILES_TABLE] as ProfessionalItem[]) || [];
        
        const existingUserSubs: string[] = existingProfessionals
            .map((p) => p.userSub?.S)
            .filter((sub): sub is string => !!sub); 

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
                (p.role?.S !== jobRole) &&
                (jobRole !== "dual_role_front_da") &&
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

        // 7. Send Invitations
        const timestamp: string = new Date().toISOString();
        const invitationResults: InvitationResult[] = [];
        const errors: InvitationError[] = [];

        for (const profSub of professionalUserSubs) {
            try {
                const invitationId: string = uuidv4();
                
                const invitationItem: Record<string, AttributeValue> = {
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
    } catch (error: any) {
        console.error("Fatal error in Lambda:", error);
        
        if (error.message === "Authorization header missing" || 
            error.message?.startsWith("Invalid authorization header") ||
            error.message === "Invalid access token format" ||
            error.message === "Failed to decode access token" ||
            error.message === "User sub not found in token claims") {
            
            return {
                statusCode: 401,
                headers: CORS_HEADERS,
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        const errorMessage: string = (error as Error).message || "Internal Server Error";
        
        return {
            statusCode: 500,
            headers: CORS_HEADERS,
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};