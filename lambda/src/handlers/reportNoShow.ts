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
    clinicNotes?: string;
    [key: string]: any;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        if (event.httpMethod === "OPTIONS") {
            return { statusCode: 200, headers: corsHeaders(event), body: "" };
        }

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
            console.error("[reportNoShow] auth failed:", authError instanceof Error ? authError.message : authError);
            return json(event, 401, { error: "Unauthorized", message: "Authentication required" });
        }

        let jobId = event.pathParameters?.jobId;
        if (!jobId && event.pathParameters?.proxy) {
            const parts = event.pathParameters.proxy.split("/");
            const idx = parts.indexOf("jobs");
            jobId = idx !== -1 && parts.length > idx + 1 ? parts[idx + 1] : parts[parts.length - 1];
        }
        if (!jobId) return json(event, 400, { error: "Missing jobId" });

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

        const clinicNotes = typeof body.clinicNotes === "string" ? body.clinicNotes.trim() : "";

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

        if (currentStatus === "no_show") {
            return json(event, 200, {
                message: "Shift already marked no-show",
                jobId,
                professionalUserSub,
                applicationStatus: "no_show",
                idempotent: true,
            });
        }

        if (currentStatus !== "scheduled") {
            return json(event, 409, {
                error: "Invalid status transition",
                message: `Cannot mark no-show from status '${currentStatus}'. Expected 'scheduled'.`,
            });
        }

        const now = new Date().toISOString();

        const updateInput: UpdateItemCommandInput = {
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub },
            },
            UpdateExpression:
                "SET applicationStatus = :noShow, noShowReportedAt = :now, " +
                "noShowReviewStatus = :pendingReview, " +
                "confirmedByUserSub = :clinicUser, confirmedAt = :now, updatedAt = :now" +
                (clinicNotes ? ", clinicNotes = :notes" : ""),
            ConditionExpression: "applicationStatus = :scheduled",
            ExpressionAttributeValues: {
                ":noShow": { S: "no_show" },
                ":scheduled": { S: "scheduled" },
                ":pendingReview": { S: "pending_review" },
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
                    message: "Shift status changed before this no-show could be applied. Refresh and try again.",
                });
            }
            throw err;
        }

        // --- Best-effort EventBridge emit (notifies professional via existing pipeline) ---
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
            };

            await eb.send(new PutEventsCommand({
                Entries: [{
                    Source: "denti-pal.api",
                    DetailType: "ShiftEvent",
                    Detail: JSON.stringify({
                        eventType: "shift-no-show",
                        clinicId,
                        professionalSub: professionalUserSub,
                        shiftDetails,
                    }),
                }],
            }));
        } catch (err) {
            console.error("[reportNoShow] eventbridge emit failed (non-fatal)", err);
        }

        return json(event, 200, {
            message: "No-show reported. Sent to DentiPal admin team for review.",
            jobId,
            professionalUserSub,
            applicationStatus: "no_show",
            noShowReviewStatus: "pending_review",
            noShowReportedAt: now,
        });
    } catch (error) {
        console.error("[reportNoShow] handler error:", error);
        if (isAuthError(error)) {
            return json(event, 401, { error: "Unauthorized", message: "Authentication required" });
        }
        return json(event, 500, { error: "Internal Server Error", message: "Failed to report no-show" });
    }
};
