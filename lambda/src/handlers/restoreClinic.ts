import {
    DynamoDBClient,
    UpdateItemCommand,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, isRoot, requireInternalGroup } from "./utils";
import { corsHeaders } from "./corsHeaders";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

const CLINICS_TABLE = process.env.CLINICS_TABLE!;
const DELETED_CLINIC_SNAPSHOTS_TABLE = process.env.DELETED_CLINIC_SNAPSHOTS_TABLE || "";

const MIN_REASON_LENGTH = 10;

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

// POST /clinics/{clinicId}/restore — Root or Admin only.
// Body: { confirmName: string, reason: string }
//
// Friction we apply on top of "user clicked Restore":
//   - Type-to-confirm: confirmName must equal the clinic's name exactly
//     (case-insensitive, trimmed). Blocks misclicks on the wrong row.
//   - Reason required: ≥10 chars. Converts impulsive undo into deliberate
//     action and gives the original deleter context if they ever ask.
//   - Audit fields are written back onto the DeletedClinicSnapshots row so
//     the restore is traceable forever. Single-table design — no separate
//     audit table needed because that row already lives forever.
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const groups = userInfo.groups;
        const restoredBySub = userInfo.sub;

        const allowed = isRoot(groups) || requireInternalGroup(groups, ["Admin"]);
        if (!allowed) {
            return json(event, 403, {
                error: "Forbidden",
                statusCode: 403,
                message: "Only Root or Admin users can restore deleted clinics.",
                timestamp: new Date().toISOString(),
            });
        }

        // Normalize: the catch-all REST proxy integration passes the full
        // path under pathParameters.proxy (including any "clinics/" prefix).
        // Strip everything before the last "/" so the lookup uses just the
        // trailing UUID segment.
        let clinicId: string | undefined =
            event.pathParameters?.clinicId || event.pathParameters?.proxy;
        if (clinicId) {
            try { clinicId = decodeURIComponent(clinicId); } catch { /* not encoded */ }
            clinicId = clinicId.trim().replace(/\/+$/, "");
            const lastSlash = clinicId.lastIndexOf("/");
            if (lastSlash >= 0) clinicId = clinicId.slice(lastSlash + 1);
            // Restore route is /clinics/{id}/restore — after stripping to the
            // last segment we'd get "restore". Reach back one segment if so.
            if (clinicId === "restore") {
                const parts = (event.pathParameters?.proxy || "").split("/").filter(Boolean);
                clinicId = parts[parts.length - 2];
            }
        }

        if (!clinicId) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Clinic ID is required",
                timestamp: new Date().toISOString(),
            });
        }

        // Parse + validate body.
        let body: { confirmName?: string; reason?: string } = {};
        try {
            body = event.body ? JSON.parse(event.body) : {};
        } catch {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Invalid JSON body. Expected { confirmName, reason }.",
                timestamp: new Date().toISOString(),
            });
        }

        const confirmName = (body.confirmName || "").trim();
        const reason = (body.reason || "").trim();

        if (!confirmName) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "confirmName is required.",
                details: { field: "confirmName" },
                timestamp: new Date().toISOString(),
            });
        }

        if (!reason || reason.length < MIN_REASON_LENGTH) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: `A reason of at least ${MIN_REASON_LENGTH} characters is required to restore a clinic.`,
                details: { field: "reason", minLength: MIN_REASON_LENGTH },
                timestamp: new Date().toISOString(),
            });
        }

        // Load the clinic row — we need it both for the soft-delete check
        // and to compare the typed confirmName against the actual clinic name.
        const existing = await dynamoClient.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        }));

        if (!existing.Item) {
            return json(event, 404, {
                error: "Not Found",
                statusCode: 404,
                message: "Clinic not found. It may have already been permanently purged.",
                timestamp: new Date().toISOString(),
            });
        }

        if (!existing.Item.deletedAt?.S) {
            return json(event, 409, {
                error: "Conflict",
                statusCode: 409,
                message: "Clinic is not deleted; nothing to restore.",
                timestamp: new Date().toISOString(),
            });
        }

        const actualName = (existing.Item.name?.S || "").trim();
        if (!actualName) {
            return json(event, 500, {
                error: "Internal Server Error",
                statusCode: 500,
                message: "Cannot verify clinic name for restore; clinic record is missing a name.",
                timestamp: new Date().toISOString(),
            });
        }

        if (confirmName.toLowerCase() !== actualName.toLowerCase()) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "The name you typed does not match the clinic name. Restore aborted.",
                details: { field: "confirmName" },
                timestamp: new Date().toISOString(),
            });
        }

        const restoredAtIso = new Date().toISOString();

        // 1) Restore the Clinics row — clears deletedAt/deletedBy/ttl. This
        //    fires the stream handler which flips related jobs back to active.
        await dynamoClient.send(new UpdateItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            UpdateExpression: "REMOVE deletedAt, deletedBy, #ttl",
            ExpressionAttributeNames: { "#ttl": "ttl" },
        }));

        // 2) Audit — append restore details to the snapshot row instead of
        //    deleting it. The same row keeps deletedAt/deletedBy from the
        //    original delete, plus restoredAt/restoredBy/restoreReason from
        //    this action. One GetItem on that row tells you the full story.
        if (DELETED_CLINIC_SNAPSHOTS_TABLE) {
            try {
                await dynamoClient.send(new UpdateItemCommand({
                    TableName: DELETED_CLINIC_SNAPSHOTS_TABLE,
                    Key: { clinicId: { S: clinicId } },
                    UpdateExpression:
                        "SET restoredAt = :restoredAt, restoredBy = :restoredBy, restoreReason = :restoreReason",
                    ExpressionAttributeValues: {
                        ":restoredAt": { S: restoredAtIso },
                        ":restoredBy": { S: restoredBySub },
                        ":restoreReason": { S: reason },
                    },
                }));
            } catch (snapErr) {
                console.warn("[restoreClinic] Failed to write audit fields onto snapshot (non-fatal):", (snapErr as Error).message);
            }
        }

        return json(event, 200, {
            status: "success",
            statusCode: 200,
            message: "Clinic restored.",
            data: {
                clinicId,
                restoredAt: restoredAtIso,
                restoredBy: restoredBySub,
            },
            timestamp: restoredAtIso,
        });
    } catch (error) {
        const err = error as Error;
        console.error("Error restoring clinic:", err);
        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to restore clinic",
            details: { reason: err.message },
            timestamp: new Date().toISOString(),
        });
    }
};

exports.handler = handler;
