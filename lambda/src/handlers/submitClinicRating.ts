import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const CLINIC_RATINGS_TABLE = process.env.CLINIC_RATINGS_TABLE!;
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE!;
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

interface RatingBody {
    jobId?: string;
    rating?: number | string;
    comment?: string;
}

function getMethod(event: APIGatewayProxyEvent): string {
    return event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
}

// Route is /clinics/{clinicId}/ratings.
function getClinicIdFromPath(event: APIGatewayProxyEvent): string | undefined {
    if (event.pathParameters?.clinicId) return event.pathParameters.clinicId;
    const proxy = event.pathParameters?.proxy;
    if (proxy) {
        const parts = proxy.split("/").filter(Boolean);
        const idx = parts.indexOf("clinics");
        if (idx >= 0 && parts[idx + 1]) return parts[idx + 1];
    }
    const raw = event.path || (event.requestContext as any)?.http?.path || "";
    const segs = raw.split("/").filter(Boolean);
    const idx = segs.findIndex((s: string) => s === "clinics");
    if (idx >= 0 && segs[idx + 1]) return segs[idx + 1];
    return undefined;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (getMethod(event) === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    // --- Auth (any signed-in pro can rate; we verify the JobApplications row owns it) ---
    let proUserSub: string;
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        proUserSub = userInfo.sub;
    } catch (err) {
        return json(event, 401, { error: "Unauthorized", message: (err as Error)?.message || "Invalid token" });
    }

    const clinicId = getClinicIdFromPath(event) || "";
    if (!clinicId) return json(event, 400, { error: "Missing clinicId" });

    let body: RatingBody = {};
    try {
        body = event.body ? JSON.parse(event.body) : {};
    } catch {
        return json(event, 400, { error: "Invalid JSON body" });
    }

    const jobId = (body.jobId || "").trim();
    const ratingNum = typeof body.rating === "string" ? parseInt(body.rating, 10) : Number(body.rating);
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";

    if (!jobId) return json(event, 400, { error: "Missing jobId" });
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return json(event, 400, { error: "Invalid rating", message: "rating must be an integer 1–5" });
    }

    // --- Verify: this pro had a shift with this clinic that's completed ---
    let application;
    try {
        application = await dynamodb.send(new GetItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
                jobId: { S: jobId },
                professionalUserSub: { S: proUserSub },
            },
        }));
    } catch (err) {
        console.error("[submitClinicRating] job application lookup failed", err);
        return json(event, 500, { error: "Lookup failed" });
    }

    if (!application.Item) {
        return json(event, 404, { error: "No application found for this (job, you)." });
    }
    const status = application.Item.applicationStatus?.S;
    if (status !== "completed") {
        return json(event, 409, {
            error: "Shift not completed",
            message: `Cannot rate a clinic for a shift in status '${status}'. Rate only after the clinic confirms the shift completed.`,
        });
    }
    const shiftClinicId = application.Item.clinicId?.S || "";
    if (!shiftClinicId) {
        return json(event, 500, { error: "Shift row missing clinicId — cannot authorize." });
    }
    if (shiftClinicId !== clinicId) {
        return json(event, 400, { error: "clinicId mismatch", message: "Path clinicId doesn't match the shift's clinic." });
    }

    // --- Optional: look up the pro's name for display alongside the rating ---
    let raterName = "";
    try {
        const proProfile = await dynamodb.send(new GetItemCommand({
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: proUserSub } },
            ProjectionExpression: "first_name, last_name",
        }));
        const fn = proProfile.Item?.first_name?.S || "";
        const ln = proProfile.Item?.last_name?.S || "";
        raterName = `${fn} ${ln}`.trim();
    } catch (err) {
        console.warn("[submitClinicRating] pro name lookup failed (non-fatal)", (err as Error)?.message);
    }

    const now = new Date().toISOString();
    const professionalJobKey = `${proUserSub}#${jobId}`;

    const item: Record<string, AttributeValue> = {
        clinicId: { S: clinicId },
        professionalJobKey: { S: professionalJobKey },
        professionalUserSub: { S: proUserSub },
        jobId: { S: jobId },
        rating: { N: String(ratingNum) },
        createdAt: { S: now },
        updatedAt: { S: now },
    };
    if (comment) item.comment = { S: comment };
    if (raterName) item.raterName = { S: raterName };

    try {
        await dynamodb.send(new PutItemCommand({
            TableName: CLINIC_RATINGS_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(professionalJobKey)",
        }));
    } catch (err: any) {
        if (err?.name === "ConditionalCheckFailedException") {
            return json(event, 409, {
                error: "Already rated",
                message: "You've already rated this clinic for this shift.",
            });
        }
        console.error("[submitClinicRating] put failed", err);
        return json(event, 500, { error: "Save failed" });
    }

    // --- Denormalize avg/count onto ClinicProfiles ---
    let avgRating: number | undefined;
    let ratingCount: number | undefined;
    try {
        const updateRes = await dynamodb.send(new UpdateItemCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: { S: clinicId } },
            UpdateExpression:
                "SET ratingSum = if_not_exists(ratingSum, :zero) + :r, " +
                "ratingCount = if_not_exists(ratingCount, :zero) + :one, " +
                "lastRatedAt = :now",
            ExpressionAttributeValues: {
                ":r": { N: String(ratingNum) },
                ":zero": { N: "0" },
                ":one": { N: "1" },
                ":now": { S: now },
            },
            ReturnValues: "ALL_NEW",
        }));
        const sum = updateRes.Attributes?.ratingSum?.N ? Number(updateRes.Attributes.ratingSum.N) : 0;
        const count = updateRes.Attributes?.ratingCount?.N ? Number(updateRes.Attributes.ratingCount.N) : 0;
        if (count > 0) {
            ratingCount = count;
            avgRating = Math.round((sum / count) * 100) / 100;
            await dynamodb.send(new UpdateItemCommand({
                TableName: CLINIC_PROFILES_TABLE,
                Key: { clinicId: { S: clinicId } },
                UpdateExpression: "SET avgRating = :a",
                ExpressionAttributeValues: { ":a": { N: String(avgRating) } },
            }));
        }
    } catch (err) {
        console.error("[submitClinicRating] aggregate update failed", err);
        // Roll back the rating row so the source of truth stays in sync.
        try {
            await dynamodb.send(new DeleteItemCommand({
                TableName: CLINIC_RATINGS_TABLE,
                Key: {
                    clinicId: { S: clinicId },
                    professionalJobKey: { S: professionalJobKey },
                },
            }));
        } catch (rollbackErr) {
            console.error("[submitClinicRating] rollback also failed", rollbackErr);
        }
        return json(event, 500, { error: "Save failed" });
    }

    return json(event, 201, {
        message: "Rating submitted.",
        rating: {
            clinicId,
            jobId,
            rating: ratingNum,
            comment: comment || undefined,
            raterName: raterName || undefined,
            professionalUserSub: proUserSub,
            createdAt: now,
        },
        aggregate: { avgRating, ratingCount },
    });
};
