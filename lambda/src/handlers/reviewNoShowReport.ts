import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    DynamoDBClient,
    GetItemCommand,
    UpdateItemCommand,
} from "@aws-sdk/client-dynamodb";
import { corsHeaders } from "./corsHeaders";
import { extractUserFromBearerToken, isInternalUser } from "./utils";

const REGION: string = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const dynamo = new DynamoDBClient({ region: REGION });
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;

const VALID_TARGET_STATUSES = new Set(["reviewed", "actioned"]);

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

interface RequestBody {
    noShowReviewStatus?: string;
    noShowResolutionNotes?: string;
    [key: string]: any;
}

/**
 * PATCH /admin/no-show-reports/{jobId}/{professionalUserSub}
 * Body: { noShowReviewStatus: 'reviewed' | 'actioned', noShowResolutionNotes?: string }
 *
 * Internal-only. Marks an open no-show report as reviewed or actioned.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        if (!isInternalUser(caller.groups)) {
            return json(event, 403, { error: "Forbidden", message: "Internal access required." });
        }

        const jobId = event.pathParameters?.jobId;
        const professionalUserSub = event.pathParameters?.professionalUserSub;
        if (!jobId || !professionalUserSub) {
            return json(event, 400, { error: "Missing path parameters: jobId and professionalUserSub are required" });
        }

        let body: RequestBody = {};
        if (event.body) {
            const raw = event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf-8") : event.body;
            try {
                body = typeof raw === "string" ? JSON.parse(raw) : (raw as any);
            } catch {
                return json(event, 400, { error: "Invalid JSON body" });
            }
        }

        const target = body.noShowReviewStatus;
        if (!target || !VALID_TARGET_STATUSES.has(target)) {
            return json(event, 400, {
                error: "Invalid noShowReviewStatus",
                message: "Must be one of: reviewed, actioned",
            });
        }

        const notes = typeof body.noShowResolutionNotes === "string" ? body.noShowResolutionNotes.trim() : "";

        // Validate the row exists and is in a valid prior state.
        const existing = await dynamo.send(new GetItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub },
            },
        }));
        if (!existing.Item) return json(event, 404, { error: "No-show report not found" });

        const currentReview = existing.Item.noShowReviewStatus?.S;
        if (existing.Item.applicationStatus?.S !== "no_show" || !currentReview) {
            return json(event, 409, {
                error: "Not a no-show report",
                message: "This shift is not a no-show or has no review record.",
            });
        }

        // Allow:  pending_review -> reviewed | actioned,  reviewed -> actioned.
        const allowed: Record<string, string[]> = {
            pending_review: ["reviewed", "actioned"],
            reviewed: ["actioned"],
        };
        if (!allowed[currentReview]?.includes(target)) {
            return json(event, 409, {
                error: "Invalid status transition",
                message: `Cannot transition review from '${currentReview}' to '${target}'.`,
            });
        }

        const now = new Date().toISOString();
        await dynamo.send(new UpdateItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: professionalUserSub },
            },
            UpdateExpression:
                "SET noShowReviewStatus = :target, noShowReviewedByUserSub = :reviewer, " +
                "noShowReviewedAt = :now, updatedAt = :now" +
                (notes ? ", noShowResolutionNotes = :notes" : ""),
            ConditionExpression: "noShowReviewStatus = :prior",
            ExpressionAttributeValues: {
                ":target": { S: target },
                ":prior": { S: currentReview },
                ":reviewer": { S: caller.sub },
                ":now": { S: now },
                ...(notes ? { ":notes": { S: notes } } : {}),
            },
        }));

        return json(event, 200, {
            status: "success",
            jobId,
            professionalUserSub,
            noShowReviewStatus: target,
            noShowReviewedAt: now,
        });
    } catch (error: any) {
        if (error?.name === "ConditionalCheckFailedException") {
            return json(event, 409, {
                error: "Status changed",
                message: "Review status changed before this update could be applied. Refresh and try again.",
            });
        }
        console.error("[reviewNoShowReport] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to update no-show report",
        });
    }
};
