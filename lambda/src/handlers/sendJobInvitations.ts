import {
    DynamoDBClient,
    QueryCommand,
    BatchGetItemCommand,
    PutItemCommand,
    AttributeValue,
    DynamoDBClientConfig,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
    PutEventsRequestEntry,
} from "@aws-sdk/client-eventbridge";
import {
    APIGatewayProxyEventV2,
    APIGatewayProxyResultV2,
    APIGatewayProxyEvent,
} from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import {
    getProfessionalAvailability,
    getScheduledOccurrences,
    jobMatchesWeekdays,
    dateIsBlocked,
    jobConflictsWithScheduled,
    jobDates,
} from "./professionalAvailability";
import { v4 as uuidv4 } from "uuid";
import { corsHeaders } from "./corsHeaders";

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
const eb = new EventBridgeClient({ region: REGION });

// --- Main Handler Function ---
export const handler = async (event: APIGatewayProxyEventV2 | APIGatewayProxyEvent): Promise<HandlerResponse> => {
    try {
        const headers = corsHeaders(event);
        
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

        // 6. Check for existing invitations to prevent duplicates
        // DynamoDB table PK=jobId, SK=professionalUserSub — so we can use GetItem
        const existingInvitationChecks = await Promise.all(
            professionalUserSubs.map(async (sub) => {
                try {
                    const resp = await dynamodb.send(new QueryCommand({
                        TableName: JOB_INVITATIONS_TABLE,
                        KeyConditionExpression: "jobId = :jid AND professionalUserSub = :psub",
                        ExpressionAttributeValues: {
                            ":jid": { S: jobId },
                            ":psub": { S: sub },
                        },
                        Limit: 1,
                    }));
                    return { sub, alreadyInvited: !!(resp.Items && resp.Items.length > 0) };
                } catch {
                    return { sub, alreadyInvited: false };
                }
            })
        );
        const alreadyInvitedSubs = new Set(
            existingInvitationChecks.filter((c) => c.alreadyInvited).map((c) => c.sub)
        );

        // 6b. Availability check per professional (Phase 2 clinic-side guard).
        // For each invitee, verify the pro is actually available for this
        // job's date/time. Pros flagged unavailable (toggle off / wrong day /
        // wrong time / blocked date / conflicting schedule) are stripped from
        // the invite batch and surfaced back in the `errors` list so the UI
        // can show the validation message from the spec.
        const unavailableReasons = new Map<string, string>();
        await Promise.all(
            professionalUserSubs.map(async (profSub) => {
                if (alreadyInvitedSubs.has(profSub)) return; // already filtered
                try {
                    const [availability, scheduled] = await Promise.all([
                        getProfessionalAvailability(profSub),
                        getScheduledOccurrences(profSub),
                    ]);

                    if (!availability.isAvailableForJobs) {
                        unavailableReasons.set(profSub, "off"); return;
                    }
                    // `JobItem` defines fields as optional; the availability
                    // helpers expect a strict Record. The runtime shape is the
                    // same — just a TS narrowing.
                    const jobAttr = job as unknown as Record<string, AttributeValue>;

                    if (!jobMatchesWeekdays(jobAttr, availability.availableDays)) {
                        unavailableReasons.set(profSub, "weekday"); return;
                    }
                    for (const d of jobDates(jobAttr)) {
                        if (dateIsBlocked(d, availability.unavailableDates)) {
                            unavailableReasons.set(profSub, "blocked_date"); return;
                        }
                    }
                    if (jobConflictsWithScheduled(jobAttr, scheduled)) {
                        unavailableReasons.set(profSub, "schedule_conflict"); return;
                    }
                } catch (err) {
                    // Don't punish the invite on a transient availability lookup
                    // failure — fall back to permissive (legacy behavior). Logged
                    // for ops visibility.
                    console.warn(`[sendJobInvitations] availability check failed for ${profSub}; allowing invite:`, (err as Error).message);
                }
            })
        );

        // 7. Send Invitations (no role filtering — all roles are allowed)
        const timestamp: string = new Date().toISOString();
        const invitationResults: InvitationResult[] = [];
        const errors: InvitationError[] = [];

        // Shared shiftDetails for downstream notifications — same job, same details for every invitee.
        const shiftDetails = {
            role: job.professional_role?.S,
            date: job.date?.S || job.start_date?.S,
            startTime: job.start_time?.S,
            endTime: job.end_time?.S,
            location: job.city?.S || job.fullAddress?.S,
            rate: job.rate?.N ? Number(job.rate.N) : undefined,
            jobType: job.job_type?.S,
        };
        const eventEntries: PutEventsRequestEntry[] = [];

        for (const profSub of professionalUserSubs) {
            if (alreadyInvitedSubs.has(profSub)) {
                errors.push({
                    professionalUserSub: profSub,
                    error: "Professional has already been invited to this job",
                });
                continue;
            }
            if (unavailableReasons.has(profSub)) {
                // Mirrors the spec's required clinic-side message; the reason
                // code lets the UI tailor the explanation if it wants to.
                errors.push({
                    professionalUserSub: profSub,
                    error: "Professional is not available for selected slot.",
                });
                continue;
            }
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

                eventEntries.push({
                    Source: "denti-pal.api",
                    DetailType: "ShiftEvent",
                    Detail: JSON.stringify({
                        eventType: "invite-sent",
                        clinicId,
                        professionalSub: profSub,
                        shiftDetails,
                    }),
                });
            } catch (err) {
                console.error(`Failed to invite ${profSub}:`, err);
                errors.push({ professionalUserSub: profSub, error: "Failed to send invitation" });
            }
        }

        // Publish invite-sent events in batches of 10 (EventBridge per-call limit).
        // Best-effort: a failure here is non-fatal so the invitations still complete.
        for (let i = 0; i < eventEntries.length; i += 10) {
            const batch = eventEntries.slice(i, i + 10);
            try {
                await eb.send(new PutEventsCommand({ Entries: batch }));
            } catch (publishErr) {
                console.error("[sendJobInvitations] failed to publish invite-sent batch (non-fatal):", (publishErr as Error).message);
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
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "Unauthorized",
                    details: error.message
                }),
            };
        }

        const errorMessage: string = (error as Error).message || "Internal Server Error";
        
        return {
            statusCode: 500,
            headers: corsHeaders(event),
            body: JSON.stringify({ error: errorMessage }),
        };
    }
};