import {
    DynamoDBClient,
    GetItemCommand,
    PutItemCommand,
    UpdateItemCommand,
    DeleteItemCommand,
    QueryCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { extractUserFromBearerToken, canWriteClinic, getClinicRole, listAccessibleClinicIds } from "./utils";
import { corsHeaders } from "./corsHeaders";

const REGION = process.env.REGION || "us-east-1";
const RATINGS_TABLE = process.env.PROFESSIONAL_RATINGS_TABLE!;
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE!;
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

interface RatingBody {
    professionalUserSub?: string;
    jobId?: string;
    clinicId?: string;
    rating?: number | string;
    comment?: string;
}

function getMethod(event: APIGatewayProxyEvent): string {
    return event.httpMethod || (event.requestContext as any)?.http?.method || "GET";
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (getMethod(event) === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    // --- Auth ---
    let raterUserSub: string;
    let raterGroups: string[];
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        raterUserSub = userInfo.sub;
        raterGroups = userInfo.groups || [];
    } catch (err) {
        return json(event, 401, { error: "Unauthorized", message: (err as Error)?.message || "Invalid token" });
    }

    // Block viewers up front; the canWriteClinic check below will block them too,
    // but failing here gives a cleaner error.
    const role = getClinicRole(raterGroups);
    if (!role || role === "clinicviewer") {
        return json(event, 403, { error: "Forbidden", message: "Only clinic admins/managers can submit ratings." });
    }

    // --- Body ---
    let body: RatingBody = {};
    try {
        body = event.body ? JSON.parse(event.body) : {};
    } catch {
        return json(event, 400, { error: "Invalid JSON body" });
    }

    const professionalUserSub = (body.professionalUserSub || "").trim();
    let jobId = (body.jobId || "").trim();
    const clinicIdFromBody = (body.clinicId || "").trim();
    const ratingNum = typeof body.rating === "string" ? parseInt(body.rating, 10) : Number(body.rating);
    const comment = typeof body.comment === "string" ? body.comment.trim().slice(0, 2000) : "";

    if (!professionalUserSub) return json(event, 400, { error: "Missing professionalUserSub" });
    if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) {
        return json(event, 400, { error: "Invalid rating", message: "rating must be an integer 1–5" });
    }

    let clinicId = "";

    if (jobId) {
        // --- Specific-shift path: verify the shift exists, is completed, belongs to a clinic the rater can write to ---
        let application;
        try {
            application = await dynamodb.send(new GetItemCommand({
                TableName: JOB_APPLICATIONS_TABLE,
                Key: {
                    jobId: { S: jobId },
                    professionalUserSub: { S: professionalUserSub },
                },
            }));
        } catch (err) {
            console.error("[submitProfessionalRating] job application lookup failed", err);
            return json(event, 500, { error: "Lookup failed" });
        }

        if (!application.Item) {
            return json(event, 404, { error: "No application found for this (job, professional)." });
        }
        const status = application.Item.applicationStatus?.S;
        if (status !== "completed") {
            return json(event, 409, {
                error: "Shift not completed",
                message: `Cannot rate a shift in status '${status}'. Rate only after the shift is confirmed completed.`,
            });
        }
        clinicId = application.Item.clinicId?.S || "";
        if (!clinicId) {
            return json(event, 500, { error: "Shift row missing clinicId — cannot authorize." });
        }
        if (clinicIdFromBody && clinicIdFromBody !== clinicId) {
            return json(event, 400, { error: "clinicId mismatch", message: "Body clinicId does not match the shift's clinicId." });
        }
    } else {
        // --- Ad-hoc path: pick the most-recent completed, un-rated shift between
        //     this professional and one of the rater's clinics. The frontend uses
        //     this when surfacing a "Rate" button from a profile view that has no
        //     specific shift in scope. ---
        const accessibleClinics = await listAccessibleClinicIds(raterUserSub, raterGroups);
        const clinicAllowList = new Set(accessibleClinics || []);
        if (clinicIdFromBody && !clinicAllowList.has(clinicIdFromBody)) {
            return json(event, 403, { error: "Forbidden", message: "You don't have access to that clinic." });
        }

        let candidates: Record<string, AttributeValue>[] = [];
        try {
            const res = await dynamodb.send(new QueryCommand({
                TableName: JOB_APPLICATIONS_TABLE,
                IndexName: "professionalUserSub-index",
                KeyConditionExpression: "professionalUserSub = :sub",
                FilterExpression: "applicationStatus = :completed",
                ExpressionAttributeValues: {
                    ":sub": { S: professionalUserSub },
                    ":completed": { S: "completed" },
                },
            }));
            candidates = res.Items || [];
        } catch (err) {
            console.error("[submitProfessionalRating] candidate query failed", err);
            return json(event, 500, { error: "Lookup failed" });
        }

        // Filter to clinics the rater can access, plus the optional clinic hint.
        const matching = candidates.filter((it) => {
            const c = it.clinicId?.S;
            if (!c) return false;
            if (!clinicAllowList.has(c)) return false;
            if (clinicIdFromBody && c !== clinicIdFromBody) return false;
            return true;
        });
        if (matching.length === 0) {
            return json(event, 404, { error: "No completed shift to rate", message: "You haven't completed a shift with this professional yet." });
        }

        // Sort by confirmedAt desc (fall back to updatedAt) and pick the first that isn't already rated.
        matching.sort((a, b) => {
            const ta = (a.confirmedAt?.S || a.updatedAt?.S || "");
            const tb = (b.confirmedAt?.S || b.updatedAt?.S || "");
            return tb.localeCompare(ta);
        });

        let pick: Record<string, AttributeValue> | undefined;
        for (const it of matching) {
            const c = it.clinicId!.S!;
            const j = it.jobId!.S!;
            const existing = await dynamodb.send(new GetItemCommand({
                TableName: RATINGS_TABLE,
                Key: {
                    professionalUserSub: { S: professionalUserSub },
                    clinicJobKey: { S: `${c}#${j}` },
                },
                ProjectionExpression: "clinicJobKey",
            }));
            if (!existing.Item) {
                pick = it;
                break;
            }
        }
        if (!pick) {
            return json(event, 409, { error: "All shifts already rated", message: "Every completed shift with this professional has already been rated." });
        }
        clinicId = pick.clinicId!.S!;
        jobId = pick.jobId!.S!;
    }

    const canWrite = await canWriteClinic(raterUserSub, raterGroups, clinicId, "manageApplicants");
    if (!canWrite) {
        return json(event, 403, { error: "Forbidden", message: "You don't have write access to the clinic that ran this shift." });
    }

    // --- Build the rating row ---
    const now = new Date().toISOString();
    const clinicJobKey = `${clinicId}#${jobId}`;

    // Look up clinic name for display (best-effort).
    let clinicName = "";
    try {
        const clinicProfile = await dynamodb.send(new GetItemCommand({
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: { S: clinicId } },
            ProjectionExpression: "clinic_name, clinicName, name",
        }));
        clinicName =
            clinicProfile.Item?.clinic_name?.S
            || clinicProfile.Item?.clinicName?.S
            || clinicProfile.Item?.name?.S
            || "";
    } catch (err) {
        console.warn("[submitProfessionalRating] clinic name lookup failed (non-fatal)", (err as Error)?.message);
    }

    const item: Record<string, AttributeValue> = {
        professionalUserSub: { S: professionalUserSub },
        clinicJobKey: { S: clinicJobKey },
        clinicId: { S: clinicId },
        jobId: { S: jobId },
        rating: { N: String(ratingNum) },
        raterUserSub: { S: raterUserSub },
        createdAt: { S: now },
        updatedAt: { S: now },
    };
    if (comment) item.comment = { S: comment };
    if (clinicName) item.clinicName = { S: clinicName };

    // --- Put with dedup ---
    try {
        await dynamodb.send(new PutItemCommand({
            TableName: RATINGS_TABLE,
            Item: item,
            ConditionExpression: "attribute_not_exists(clinicJobKey)",
        }));
    } catch (err: any) {
        if (err?.name === "ConditionalCheckFailedException") {
            return json(event, 409, {
                error: "Already rated",
                message: "This shift has already been rated. Each shift can only be rated once.",
            });
        }
        console.error("[submitProfessionalRating] put failed", err);
        return json(event, 500, { error: "Save failed" });
    }

    // --- Update the denormalized avg/count on the professional's profile ---
    // Read-modify-write is fine here: rating volume is low (≤ 1 per completed shift)
    // and there's no concurrent-write hot path. If volume grows, move this onto a
    // DDB stream → updater Lambda.
    let avgRating: number | undefined;
    let ratingCount: number | undefined;
    try {
        const updateRes = await dynamodb.send(new UpdateItemCommand({
            TableName: PROFESSIONAL_PROFILES_TABLE,
            Key: { userSub: { S: professionalUserSub } },
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
            // Persist the rounded avg so reads don't need to re-compute it.
            await dynamodb.send(new UpdateItemCommand({
                TableName: PROFESSIONAL_PROFILES_TABLE,
                Key: { userSub: { S: professionalUserSub } },
                UpdateExpression: "SET avgRating = :a",
                ExpressionAttributeValues: { ":a": { N: String(avgRating) } },
            }));
        }
    } catch (err) {
        // Aggregate update is best-effort. The rating row is the source of truth;
        // a recompute job (or a future stream-based updater) can heal drift.
        console.error("[submitProfessionalRating] aggregate update failed (non-fatal)", err);
        // Roll the rating row back so the source of truth and the denorm don't drift
        // without a way to recover. The user will see a generic error and can retry.
        try {
            await dynamodb.send(new DeleteItemCommand({
                TableName: RATINGS_TABLE,
                Key: {
                    professionalUserSub: { S: professionalUserSub },
                    clinicJobKey: { S: clinicJobKey },
                },
            }));
        } catch (rollbackErr) {
            console.error("[submitProfessionalRating] rollback also failed", rollbackErr);
        }
        return json(event, 500, { error: "Save failed" });
    }

    return json(event, 201, {
        message: "Rating submitted.",
        rating: {
            professionalUserSub,
            clinicId,
            jobId,
            rating: ratingNum,
            comment: comment || undefined,
            clinicName: clinicName || undefined,
            raterUserSub,
            createdAt: now,
        },
        aggregate: { avgRating, ratingCount },
    });
};
