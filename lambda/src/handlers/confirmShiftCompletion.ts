import {
    DynamoDBClient,
    GetItemCommand,
    QueryCommand,
    UpdateItemCommand,
    UpdateItemCommandInput,
} from "@aws-sdk/client-dynamodb";
import {
    EventBridgeClient,
    PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { creditReferralBonusOnCompletion } from "./referralBonus";

const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;

const dynamo = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
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

interface RequestBody {
    professionalUserSub?: string;
    professional_user_sub?: string;
    actualHoursWorked?: number | string;
    clinicNotes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders(event), body: "" };
        }

        // --- Auth: clinic write roles only ---
        let clinicUserSub: string;
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            clinicUserSub = userInfo.sub;
            const groups: string[] = userInfo.groups || [];
            const ALLOWED = new Set(["root", "clinicadmin", "clinicmanager"]);
            if (!groups.some((g) => ALLOWED.has(g.toLowerCase()))) {
                return json(event, 403, { error: "Forbidden", message: "Access denied: insufficient permissions" });
            }
        } catch (authError) {
            console.error("[confirmShiftCompletion] auth failed:", authError instanceof Error ? authError.message : authError);
            return json(event, 401, { error: "Unauthorized", message: "Authentication required" });
        }

        // --- Path param ---
        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
            const parts = event.pathParameters.proxy.split("/");
            const idx = parts.indexOf("jobs");
            jobId = idx !== -1 && parts.length > idx + 1 ? parts[idx + 1] : parts[parts.length - 1];
        }
        if (!jobId) return json(event, 400, { error: "Missing jobId" });

        // --- Body ---
        let body: RequestBody = {};
        if (event.body) {
            const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
            try {
                body = typeof raw === "string" ? JSON.parse(raw) : (raw as any);
            } catch {
                return json(event, 400, { error: "Invalid JSON body" });
            }
        }

        const professionalUserSub = body.professionalUserSub || body.professional_user_sub;
        if (!professionalUserSub) {
            return json(event, 400, { error: "Missing professionalUserSub" });
        }

        const hoursRaw = body.actualHoursWorked;
        const hoursNum = typeof hoursRaw === "string" ? parseFloat(hoursRaw) : Number(hoursRaw);
        if (!Number.isFinite(hoursNum) || hoursNum <= 0 || hoursNum > 24) {
            return json(event, 400, {
                error: "Invalid actualHoursWorked",
                message: "actualHoursWorked must be a positive number between 0 and 24",
            });
        }

        const clinicNotes = typeof body.clinicNotes === "string" ? body.clinicNotes.trim() : "";

        // --- Validate row exists ---
        const existing = await dynamo.send(new GetItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub },
            },
        }));

        if (!existing.Item) {
            return json(event, 404, { error: "No matching application found" });
        }

        const currentStatus = existing.Item.applicationStatus?.S;

        // Idempotency: if already completed by this same flow, return 200 without
        // re-firing referral bonus. `ratingEligible` is still true on the idempotent
        // path so the frontend can re-open the rating prompt if the user dismissed it.
        if (currentStatus === "completed") {
            return json(event, 200, {
                message: "Shift already marked completed",
                jobId,
                professionalUserSub,
                applicationStatus: "completed",
                idempotent: true,
                ratingEligible: true,
                clinicId: existing.Item.clinicId?.S || undefined,
            });
        }

        // "accepted" is a legacy spelling of "scheduled" from an earlier
        // version of acceptProf / respondToNegotiation. Treat both as
        // confirmable so old rows aren't stuck.
        const CONFIRMABLE_STATUSES = new Set(["scheduled", "accepted"]);
        if (!currentStatus || !CONFIRMABLE_STATUSES.has(currentStatus)) {
            return json(event, 409, {
                error: "Invalid status transition",
                message: `Shift cannot be confirmed from status '${currentStatus ?? "unknown"}'. Expected 'scheduled' or 'accepted'.`,
            });
        }

        const now = new Date().toISOString();

        // --- Conditional update: only flip if still scheduled ---
        const updateInput: UpdateItemCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub },
            },
            UpdateExpression:
                "SET applicationStatus = :completed, actualHoursWorked = :hours, " +
                "confirmedByUserSub = :clinicUser, confirmedAt = :now, updatedAt = :now" +
                (clinicNotes ? ", clinicNotes = :notes" : ""),
            ConditionExpression: "applicationStatus = :scheduled OR applicationStatus = :accepted",
            ExpressionAttributeValues: {
                ":completed": { S: "completed" },
                ":scheduled": { S: "scheduled" },
                ":accepted": { S: "accepted" },
                ":hours": { N: String(hoursNum) },
                ":clinicUser": { S: clinicUserSub },
                ":now": { S: now },
                ...(clinicNotes ? { ":notes": { S: clinicNotes } } : {}),
            },
        };

        try {
            await dynamo.send(new UpdateItemCommand(updateInput));
        } catch (err: any) {
            if (err?.name === "ConditionalCheckFailedException") {
                return json(event, 409, {
                    error: "Status changed",
                    message: "Shift status changed before this confirmation could be applied. Refresh and try again.",
                });
            }
            throw err;
        }

        // --- Referral bonus (best-effort, non-fatal) ---
        try {
            await creditReferralBonusOnCompletion(professionalUserSub);
        } catch (err) {
            console.error("[confirmShiftCompletion] referral bonus crediting failed (non-fatal)", err);
        }

        // --- Best-effort EventBridge notification ---
        try {
            const clinicId = existing.Item.clinicId?.S;
            let jobItem: Record<string, any> | null = null;
            if (clinicId) {
                const jobRes = await dynamo.send(new QueryCommand({
                    TableName: JOB_POSTINGS_TABLE,
                    IndexName: "jobId-index-1",
                    KeyConditionExpression: "jobId = :jid",
                    ExpressionAttributeValues: { ":jid": { S: jobId } },
                    Limit: 1,
                }));
                jobItem = (jobRes.Items || [])[0] || null;
            }

            const shiftDetails = {
                date: jobItem?.date?.S || jobItem?.start_date?.S || existing.Item.date?.S || "",
                role: jobItem?.professional_role?.S || existing.Item.professionalRole?.S || "Professional",
                rate: jobItem?.rate?.N ? Number(jobItem.rate.N) : 0,
                startTime: jobItem?.start_time?.S || "",
                endTime: jobItem?.end_time?.S || "",
                location: jobItem?.city?.S || jobItem?.fullAddress?.S || "",
                jobType: jobItem?.job_type?.S || "",
                actualHoursWorked: hoursNum,
            };

            await eb.send(new PutEventsCommand({
                Entries: [{
                    Source: "denti-pal.api",
                    DetailType: "ShiftEvent",
                    Detail: JSON.stringify({
                        eventType: "shift-completed",
                        clinicId,
                        professionalSub: professionalUserSub,
                        shiftDetails,
                    }),
                }],
            }));
        } catch (err) {
            console.error("[confirmShiftCompletion] eventbridge emit failed (non-fatal)", err);
        }

        return json(event, 200, {
            message: "Shift confirmed completed",
            jobId,
            professionalUserSub,
            applicationStatus: "completed",
            actualHoursWorked: hoursNum,
            confirmedAt: now,
            // The frontend opens the clinic→professional rating modal when this
            // is true. Stays true on the idempotent path above as well.
            ratingEligible: true,
            clinicId: existing.Item.clinicId?.S || undefined,
        });
    } catch (error) {
        console.error("[confirmShiftCompletion] handler error:", error);
        if (isAuthError(error)) {
            return json(event, 401, { error: "Unauthorized", message: "Authentication required" });
        }
        return json(event, 500, { error: "Internal Server Error", message: "Failed to confirm shift" });
    }
};
