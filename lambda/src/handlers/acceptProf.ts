import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    UpdateItemCommandInput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyResult, APIGatewayProxyEvent } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
import {
    getProfessionalAvailability,
    getScheduledOccurrences,
    jobMatchesWeekdays,
    dateIsBlocked,
    jobConflictsWithScheduled,
    jobDates,
} from "./professionalAvailability";

// --- Initialization ---
const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;
const JOB_NEGOTIATIONS_TABLE = process.env.JOB_NEGOTIATIONS_TABLE!;

const numFromAttr = (v: AttributeValue | undefined): number | null => {
    if (!v) return null;
    if (typeof v.N === "string") {
        const n = Number(v.N);
        return Number.isFinite(n) ? n : null;
    }
    if (typeof v.S === "string" && v.S.trim() !== "" && !isNaN(+v.S)) {
        const n = Number(v.S);
        return Number.isFinite(n) ? n : null;
    }
    return null;
};

const positive = (n: number | null): number | null =>
    n != null && Number.isFinite(n) && n > 0 ? n : null;

const dynamo = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj)
});

function isAuthError(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : "";
    return (
        msg === "Authorization header missing" ||
        msg.startsWith("Invalid authorization header") ||
        msg === "Invalid access token format" ||
        msg === "Failed to decode access token" ||
        msg === "User sub not found in token claims"
    );
}

function getClinicIdFromEvent(event: any): string | null {
    const claims = event?.requestContext?.authorizer?.claims || event?.requestContext?.authorizer?.jwt?.claims;
    if (claims && typeof claims["custom:clinicId"] === "string") {
        return claims["custom:clinicId"];
    }
    return null;
}

interface RequestBody {
    professionalUserSub?: string;
    professional_user_sub?: string;
    clinicId?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        // 🔍 DEBUG LOGS
        console.log("--- DEBUG START ---");
        console.log("HTTP Method:", event.httpMethod);
        console.log("Path Params:", event.pathParameters);
        console.log("Raw Body Type:", typeof event.body);
        
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders(event), body: "" };
        }

        // --- Step 1: Authentication ---
        // Captured here so the statusHistory entry written in step 7 can
        // record which clinic user actually triggered the transition.
        let acceptingUserSub = "clinic";
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);

            const groups: string[] = userInfo.groups || [];
            const ALLOWED = new Set(["root", "clinicadmin", "clinicmanager"]);
            const isAllowed = groups.some((g) => ALLOWED.has(g.toLowerCase()));

            if (!isAllowed) {
                return json(event, 403, { status: "error", statusCode: 403, error: "Forbidden", message: "Access denied: insufficient permissions" });
            }
            if (userInfo.sub) acceptingUserSub = userInfo.sub;
        } catch (authError) {
            console.error("Authentication failed:", authError instanceof Error ? authError.message : authError);
            return json(event, 401, { status: "error", statusCode: 401, error: "Unauthorized", message: "Authentication required" });
        }

        // --- Step 2: Extract Job ID ---
        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
            const pathParts = event.pathParameters.proxy.split('/');
            const jobsIndex = pathParts.indexOf("jobs");
            if (jobsIndex !== -1 && pathParts.length > jobsIndex + 1) {
                jobId = pathParts[jobsIndex + 1];
            } else {
                jobId = pathParts[pathParts.length - 1];
            }
        }

        if (!jobId) {
            return json(event, 400, { error: "Missing or invalid jobId in path" });
        }

        // --- ✅ Step 3: Parse Request Body (STRICT CHECK) ---
        let body: RequestBody = {};
        let bodyString = event.body;

        // 🛑 FIX 1: Fail fast if body is completely missing
        if (bodyString === null || bodyString === undefined || bodyString === "") {
             console.error("❌ ERROR: Body is null or empty string");
             return json(event, 400, { 
                 error: "Request body is empty", 
                 hint: "Ensure you are sending JSON in the request body, not as Query Params." 
             });
        }

        if (event.isBase64Encoded && bodyString) {
            bodyString = Buffer.from(bodyString, 'base64').toString('utf-8');
        }

        if (typeof bodyString === 'string') {
            try {
                body = JSON.parse(bodyString);
            } catch (e) {
                return json(event, 400, { error: "Invalid JSON format in body", rawBody: bodyString });
            }
        } else if (typeof bodyString === 'object') {
            body = bodyString;
        }

        console.log("Parsed Body:", JSON.stringify(body));

        const professionalUserSub = body.professionalUserSub || body.professional_user_sub;

        if (!professionalUserSub) {
            return json(event, 400, { 
                error: "Missing professionalUserSub in request body",
                details: { receivedKeys: Object.keys(body) }
            });
        }

        // --- Step 4: Validate Application Exists ---
        const getCommand = new GetItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            }
        });

        const getResult = await dynamo.send(getCommand);
        const matchingItem = getResult.Item;

        if (!matchingItem) {
            return json(event, 404, { error: "No matching application found" });
        }


        // --- Step 5: Availability check (Phase 2 clinic-side validation) ---
        // Before flipping the application to "scheduled", verify the pro is
        // actually available for this job's date/time. Catches:
        //   - master toggle OFF
        //   - pro removed the weekday from their availability after applying
        //   - pro marked this date unavailable after applying
        //   - pro narrowed their time windows so the shift no longer fits
        //   - pro got booked elsewhere for an overlapping slot
        //
        // Returning 409 here means the clinic sees a clear "Professional is
        // not available for selected slot" message; existing scheduled jobs
        // remain untouched. Doing this BEFORE the rate-lookup / update-write
        // means a rejected hire never touches DynamoDB writes or the
        // negotiations table query.
        let preHireJobItem: Record<string, any> | null = null;
        try {
            const jobRes = await dynamo.send(new QueryCommand({
                TableName: JOB_POSTINGS_TABLE,
                IndexName: "jobId-index-1",
                KeyConditionExpression: "jobId = :jid",
                ExpressionAttributeValues: { ":jid": { S: jobId } },
                Limit: 1,
            }));
            preHireJobItem = (jobRes.Items || [])[0] || null;
        } catch (e) {
            console.warn("[acceptProf] Pre-hire job lookup failed (non-fatal for legacy validation):", (e as Error).message);
        }

        if (preHireJobItem) {
            const [availability, scheduled] = await Promise.all([
                getProfessionalAvailability(professionalUserSub),
                getScheduledOccurrences(professionalUserSub),
            ]);

            if (!availability.isAvailableForJobs) {
                return json(event, 409, {
                    status: "error",
                    error: "ProfessionalUnavailable",
                    message: "Professional is not available for selected slot.",
                    details: { reason: "off" },
                });
            }
            if (!jobMatchesWeekdays(preHireJobItem, availability.availableDays)) {
                return json(event, 409, {
                    status: "error",
                    error: "ProfessionalUnavailable",
                    message: "Professional is not available for selected slot.",
                    details: { reason: "weekday" },
                });
            }
            for (const d of jobDates(preHireJobItem)) {
                if (dateIsBlocked(d, availability.unavailableDates)) {
                    return json(event, 409, {
                        status: "error",
                        error: "ProfessionalUnavailable",
                        message: "Professional is not available for selected slot.",
                        details: { reason: "blocked_date", date: d },
                    });
                }
            }
            if (jobConflictsWithScheduled(preHireJobItem, scheduled)) {
                return json(event, 409, {
                    status: "error",
                    error: "ProfessionalUnavailable",
                    message: "Professional is not available for selected slot.",
                    details: { reason: "schedule_conflict" },
                });
            }
        }

        // --- Step 6: Resolve the accepted rate ---
        // When the applicant negotiated, the application row carries proposedRate
        // and a negotiationId pointing at the live counter-offer thread. Persist
        // the agreed-on amount as acceptedRate so the professional dashboard's
        // Scheduled tab renders the negotiated rate, not the original posting rate.
        // Priority: negotiation.agreedRate → professionalCounterRate → clinicCounterRate
        //           → negotiation.proposedRate → application.proposedRate.
        let acceptedRate: number | null = null;
        const negotiationIdFromApp = matchingItem.negotiationId?.S;
        if (negotiationIdFromApp) {
            try {
                const negoRes = await dynamo.send(new QueryCommand({
                    TableName: JOB_NEGOTIATIONS_TABLE,
                    IndexName: "applicationId-index",
                    KeyConditionExpression: "applicationId = :aid",
                    ExpressionAttributeValues: {
                        ":aid": { S: matchingItem.applicationId?.S || "" },
                    },
                }));
                const negoItems = negoRes.Items || [];
                let latest = negoItems[0];
                for (let i = 1; i < negoItems.length; i++) {
                    const a = negoItems[i].updatedAt?.S || negoItems[i].createdAt?.S || "";
                    const b = latest.updatedAt?.S || latest.createdAt?.S || "";
                    if (a > b) latest = negoItems[i];
                }
                if (latest) {
                    acceptedRate =
                        positive(numFromAttr(latest.agreedRate) ?? numFromAttr(latest.agreedHourlyRate)) ??
                        positive(numFromAttr(latest.professionalCounterRate) ?? numFromAttr(latest.professionalCounterHourlyRate)) ??
                        positive(numFromAttr(latest.clinicCounterRate) ?? numFromAttr(latest.clinicCounterHourlyRate)) ??
                        positive(numFromAttr(latest.proposedRate) ?? numFromAttr(latest.proposedHourlyRate));
                }
            } catch (e) {
                console.warn("[acceptProf] negotiation lookup failed (non-fatal):", (e as Error).message);
            }
        }
        if (acceptedRate == null) {
            acceptedRate = positive(numFromAttr(matchingItem.proposedRate) ?? numFromAttr(matchingItem.proposedHourlyRate));
        }

        // --- Step 7: Update Application (status + acceptedRate when resolved) ---
        // Append a statusHistory entry in the same UpdateItem so the audit
        // trail and the status flip are atomic. `if_not_exists` covers legacy
        // applications created before the statusHistory rollout — they get an
        // array seeded with this one transition. The ConditionExpression makes
        // the operation idempotent: re-clicking Accept on an already-scheduled
        // applicant lands in the catch branch below and we skip the side
        // effects (EventBridge, job posting "filled" update) cleanly.
        const nowIso = new Date().toISOString();
        const updateAttrValues: { [key: string]: AttributeValue } = {
            ":status": { S: "scheduled" },
            ":now": { S: nowIso },
            ":empty": { L: [] },
            ":entry": {
                L: [
                    {
                        M: {
                            status: { S: "scheduled" },
                            at: { S: nowIso },
                            actorId: { S: acceptingUserSub },
                            actorRole: { S: "clinic" },
                        },
                    },
                ],
            },
        };
        let updateExpr =
            "SET applicationStatus = :status, updatedAt = :now, " +
            "statusHistory = list_append(if_not_exists(statusHistory, :empty), :entry)";
        if (acceptedRate != null) {
            updateExpr += ", acceptedRate = :acceptedRate";
            updateAttrValues[":acceptedRate"] = { N: String(acceptedRate) };
        }
        const updateCommandInput: UpdateItemCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub }
            },
            UpdateExpression: updateExpr,
            ConditionExpression: "applicationStatus <> :status",
            ExpressionAttributeValues: updateAttrValues,
        };

        let alreadyScheduled = false;
        try {
            await dynamo.send(new UpdateItemCommand(updateCommandInput));
        } catch (e) {
            if ((e as { name?: string })?.name === "ConditionalCheckFailedException") {
                // Already scheduled — treat as idempotent success and skip the
                // side effects below so we don't double-fan-out notifications.
                alreadyScheduled = true;
                console.log("[acceptProf] Application already scheduled; treating as no-op", {
                    jobId,
                    professionalUserSub,
                });
            } else {
                throw e;
            }
        }

        if (alreadyScheduled) {
            return json(event, 200, {
                message: "Professional already scheduled — no changes applied",
                jobId,
                professionalUserSub,
                inboxMessageSent: false,
                idempotent: true,
            });
        }

        // --- Step 8: Emit EventBridge Event (triggers inbox conversation) ---
        const clinicIdFromClaims = getClinicIdFromEvent(event);
        const clinicId = clinicIdFromClaims || body.clinicId || matchingItem.clinicId?.S || null;

        let inboxMessageSent = false;

        // Fetch the actual job posting for shift details. Reuse the row fetched
        // for the availability check when available so we don't pay for the
        // same query twice on the happy path.
        let jobItem: Record<string, any> | null = preHireJobItem;
        if (clinicId && !jobItem) {
            try {
                const jobRes = await dynamo.send(new QueryCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    IndexName: "jobId-index-1",
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: jobId } },
                    Limit: 1,
                }));
                jobItem = (jobRes.Items || [])[0] || null;
            } catch (e) {
                console.warn("Failed to fetch job posting for shift details:", (e as Error).message);
            }
        }

        // Mark the JobPostings row as filled. Best-effort: a failure here is
        // non-fatal so the hire still completes — the existing behavior was
        // for this write to never happen, so any failure mode here just lands
        // back at today's stale-status state.
        if (jobItem) {
            const jobItemClinicUserSub = jobItem.clinicUserSub?.S;
            if (jobItemClinicUserSub) {
                try {
                    await dynamo.send(new UpdateItemCommand({
                        TableName: JOB_POSTINGS_TABLE,
                        Key: {
                            clinicUserSub: { S: jobItemClinicUserSub },
                            jobId: { S: jobId },
                        },
                        UpdateExpression: "SET #s = :filled, updatedAt = :now",
                        ExpressionAttributeNames: { "#s": "status" },
                        ExpressionAttributeValues: {
                            ":filled": { S: "filled" },
                            ":now": { S: new Date().toISOString() },
                        },
                    }));
                } catch (err) {
                    console.error("[acceptProf] Failed to mark JobPostings as filled (non-fatal):", {
                        jobId,
                        error: (err as Error).message,
                    });
                }
            }
        }

        if (clinicId) {
            const shiftDate = jobItem?.date?.S || jobItem?.start_date?.S || matchingItem.date?.S || "TBD";
            const shiftRole = jobItem?.professional_role?.S || matchingItem.role?.S || matchingItem.professionalRole?.S || "Professional";
            const shiftRate = acceptedRate != null ? acceptedRate
                : matchingItem.proposedRate?.N ? Number(matchingItem.proposedRate.N)
                : (jobItem?.rate?.N ? Number(jobItem.rate.N) : 0);
            const shiftStartTime = jobItem?.start_time?.S || "";
            const shiftEndTime = jobItem?.end_time?.S || "";
            const shiftLocation = jobItem?.city?.S || jobItem?.fullAddress?.S || "";
            const jobType = jobItem?.job_type?.S || "";

            // Format date nicely
            let formattedDate = shiftDate;
            try {
                const d = new Date(shiftDate);
                if (!isNaN(d.getTime())) {
                    formattedDate = d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
                }
            } catch {}

            const shiftDetails = {
                date: formattedDate,
                role: shiftRole.split("_").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
                rate: shiftRate,
                startTime: shiftStartTime,
                endTime: shiftEndTime,
                location: shiftLocation,
                jobType,
            };

            // Best-effort: if EventBridge is unavailable or the caller's role
            // lacks events:PutEvents, the inbox notification is skipped but the
            // hire still completes. Matches the non-fatal pattern used by the
            // JobPostings "filled" status update above.
            try {
                await eb.send(new PutEventsCommand({
                    Entries: [{
                        Source: "denti-pal.api",
                        DetailType: "ShiftEvent",
                        Detail: JSON.stringify({
                            eventType: "shift-scheduled",
                            clinicId,
                            professionalSub: professionalUserSub,
                            jobId,
                            shiftDetails
                        })
                    }]
                }));
                inboxMessageSent = true;
            } catch (ebErr) {
                console.warn("[acceptProf] EventBridge PutEvents failed (non-fatal):", {
                    jobId,
                    error: (ebErr as Error).message,
                });
            }
        } else {
            console.error("WARNING: clinicId is missing — inbox conversation will NOT be created.", {
                jobId,
                professionalUserSub,
                clinicIdFromClaims,
                bodyClinicId: body.clinicId,
                itemClinicId: matchingItem.clinicId?.S,
            });
        }

        // --- Step 9: Auto-reject the remaining applicants (best-effort) ---
        // Why: this posting is now filled, so every other still-pending /
        // negotiating / invited applicant should stop showing on the clinic's
        // Applicants and Action Needed views and stop being able to be
        // re-actioned. The downstream dashboard filters already drop rows
        // whose applicationStatus is "rejected", so flipping them here is the
        // single source-of-truth update that clears all three surfaces at once.
        //
        // Safety:
        //   - Skips the just-hired sub (it's now "scheduled").
        //   - Only flips rows whose status is NOT already terminal — the
        //     ConditionExpression makes each write race-safe and idempotent.
        //   - Wrapped in Promise.allSettled inside a try/catch so a partial
        //     failure leaves the hire intact and only logs the warning.
        //   - No EventBridge fan-out: avoids spamming N losers with email on
        //     each accept; rejection state is auditable via statusHistory.
        try {
            const TERMINAL_APP_STATUSES = [
                "accepted",
                "rejected",
                "scheduled",
                "completed",
                "hired",
                "declined",
                "confirmed",
                "cancelled",
            ];

            const otherAppsRes = await dynamo.send(new QueryCommand({
                TableName: JOB_APPLICATIONS_TABLE,
                KeyConditionExpression: "jobId = :jid",
                ExpressionAttributeValues: { ":jid": { S: jobId } },
                ProjectionExpression: "jobId, professionalUserSub, applicationStatus",
            }));

            const candidates = (otherAppsRes.Items || []).filter((row) => {
                const sub = row.professionalUserSub?.S;
                if (!sub || sub === professionalUserSub) return false;
                const st = (row.applicationStatus?.S || "").toLowerCase();
                return st !== "" && !TERMINAL_APP_STATUSES.includes(st);
            });

            if (candidates.length > 0) {
                const rejectIso = new Date().toISOString();
                const results = await Promise.allSettled(candidates.map((row) => {
                    const otherSub = row.professionalUserSub!.S!;
                    return dynamo.send(new UpdateItemCommand({
                        TableName: JOB_APPLICATIONS_TABLE,
                        Key: {
                            jobId: { S: jobId },
                            professionalUserSub: { S: otherSub },
                        },
                        UpdateExpression:
                            "SET applicationStatus = :rejected, updatedAt = :now, " +
                            "statusHistory = list_append(if_not_exists(statusHistory, :empty), :entry)",
                        ConditionExpression:
                            "NOT (applicationStatus IN " +
                            "(:accepted, :rejected, :scheduled, :completed, :hired, :declined, :confirmed, :cancelled))",
                        ExpressionAttributeValues: {
                            ":rejected": { S: "rejected" },
                            ":now": { S: rejectIso },
                            ":empty": { L: [] },
                            ":entry": {
                                L: [{
                                    M: {
                                        status: { S: "rejected" },
                                        at: { S: rejectIso },
                                        actorId: { S: acceptingUserSub },
                                        actorRole: { S: "system" },
                                        reason: { S: "position_filled" },
                                    },
                                }],
                            },
                            ":accepted": { S: "accepted" },
                            ":scheduled": { S: "scheduled" },
                            ":completed": { S: "completed" },
                            ":hired": { S: "hired" },
                            ":declined": { S: "declined" },
                            ":confirmed": { S: "confirmed" },
                            ":cancelled": { S: "cancelled" },
                        },
                    }));
                }));

                const flipped = results.filter((r) => r.status === "fulfilled").length;
                const raced = results.filter((r) =>
                    r.status === "rejected" &&
                    ((r as PromiseRejectedResult).reason as { name?: string })?.name === "ConditionalCheckFailedException"
                ).length;
                const failed = results.length - flipped - raced;
                console.log("[acceptProf] auto-reject summary", {
                    jobId,
                    candidates: candidates.length,
                    flipped,
                    raced,
                    failed,
                });
                if (failed > 0) {
                    results
                        .filter((r) => r.status === "rejected")
                        .forEach((r, i) => {
                            const reason = (r as PromiseRejectedResult).reason;
                            if ((reason as { name?: string })?.name !== "ConditionalCheckFailedException") {
                                console.warn("[acceptProf] auto-reject row failed (non-fatal):", {
                                    jobId,
                                    error: (reason as Error)?.message || String(reason),
                                });
                            }
                        });
                }
            }
        } catch (autoRejectErr) {
            console.error("[acceptProf] auto-reject sweep failed (non-fatal):", {
                jobId,
                error: (autoRejectErr as Error).message,
            });
        }

        return json(event, 200, {
            message: "Professional accepted and status updated to scheduled",
            jobId,
            professionalUserSub,
            inboxMessageSent,
            ...(inboxMessageSent ? {} : { warning: "clinicId not found — inbox conversation was not created. Provide clinicId in the request body or ensure it exists in the job application." }),
        });

    } catch (error) {
        console.error("Error in handler:", error);
        if (isAuthError(error)) {
            return json(event, 401, { status: "error", statusCode: 401, error: "Unauthorized", message: "Authentication required" });
        }
        // Surface the real reason in the response body so chat (and any other
        // caller) can show something actionable instead of a flat
        // "Failed to accept applicant". Server logs above retain full stack.
        const detail = error instanceof Error ? error.message : String(error);
        return json(event, 500, {
            status: "error",
            statusCode: 500,
            error: "Internal Server Error",
            message: `Failed to accept applicant: ${detail}`,
        });
    }
};