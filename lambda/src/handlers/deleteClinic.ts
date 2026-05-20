import {
    DynamoDBClient,
    UpdateItemCommand,
    UpdateItemCommandInput,
    PutItemCommand,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, canWriteClinic } from "./utils";
import { corsHeaders } from "./corsHeaders";

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

const CLINICS_TABLE = process.env.CLINICS_TABLE!;
const DELETED_CLINIC_SNAPSHOTS_TABLE = process.env.DELETED_CLINIC_SNAPSHOTS_TABLE || "";

// 30 days in seconds — DynamoDB TTL fires off this attribute. After TTL deletes
// the row, the Clinics stream fires a REMOVE event and cascadeClinicDataUpdate
// runs the hard purge of all clinic-scoped data.
const SOFT_DELETE_RETENTION_SECONDS = 30 * 24 * 60 * 60;

const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(bodyObj),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    const method: string = event.httpMethod || (event as any).requestContext?.http?.method || "GET";

    console.log("[deleteClinic] ENTRY", {
        method,
        path: (event as any).path || (event as any).rawPath,
        rawPathParameters: event.pathParameters,
        envCLINICS_TABLE: process.env.CLINICS_TABLE,
        envREGION: process.env.REGION,
    });

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        const groups = userInfo.groups;

        const rawClinicId =
            event.pathParameters?.clinicId || event.pathParameters?.proxy;

        // Defensive normalization — URL-decode, trim whitespace, strip any
        // trailing slash. If the frontend ever sends an encoded UUID or
        // accidental trailing characters, GetItem will silently miss and we'd
        // wrongly return 404.
        let clinicId: string | undefined = rawClinicId;
        if (clinicId) {
            try { clinicId = decodeURIComponent(clinicId); } catch { /* not encoded */ }
            clinicId = clinicId.trim().replace(/\/+$/, "");
        }

        console.log("[deleteClinic] auth+id resolved", {
            userSub,
            groups,
            rawClinicId,
            normalizedClinicId: clinicId,
            normalizedLength: clinicId?.length,
            normalizedBytes: clinicId
                ? Array.from(clinicId).map((c) => c.charCodeAt(0))
                : null,
        });

        if (!clinicId) {
            return json(event, 400, {
                error: "Bad Request",
                statusCode: 400,
                message: "Clinic ID is required",
                details: { pathFormat: "/clinics/{clinicId}" },
                timestamp: new Date().toISOString(),
            });
        }

        // Load the clinic FIRST. The auth gate (canWriteClinic) also does a
        // GetItem internally and returns false if the row is missing or
        // soft-deleted — which produces a misleading 403. By looking the row
        // up here first, we can return precise 404/409 errors and reserve the
        // 403 for actual permission failures.
        const getInput = {
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        };
        console.log("[deleteClinic] GetItem request", getInput);
        const existing = await dynamoClient.send(new GetItemCommand(getInput));
        console.log("[deleteClinic] GetItem response", {
            hasItem: !!existing.Item,
            itemKeys: existing.Item ? Object.keys(existing.Item) : null,
            consumedCapacity: existing.$metadata?.httpStatusCode,
            requestId: existing.$metadata?.requestId,
        });

        if (!existing.Item) {
            // Belt-and-suspenders fallback: if GetItem somehow misses a row
            // that exists, fall through to a Query so we can see whether the
            // row is reachable by the same partition key value through a
            // different read API. If Query returns it, the discrepancy is
            // logged loudly and we proceed with the soft-delete instead of
            // returning a misleading 404.
            console.warn("[deleteClinic] GetItem returned no Item — running fallback Query to diagnose", {
                clinicId,
                table: CLINICS_TABLE,
            });
            try {
                const { QueryCommand } = await import("@aws-sdk/client-dynamodb");
                const q = await dynamoClient.send(new QueryCommand({
                    TableName: CLINICS_TABLE,
                    KeyConditionExpression: "clinicId = :cid",
                    ExpressionAttributeValues: { ":cid": { S: clinicId } },
                    Limit: 1,
                }));
                console.warn("[deleteClinic] Fallback Query result", {
                    count: q.Count,
                    scannedCount: q.ScannedCount,
                    firstItemKeys: q.Items?.[0] ? Object.keys(q.Items[0]) : null,
                });
                if (q.Items && q.Items.length > 0) {
                    console.error("[deleteClinic] BUG: GetItem missed a row that Query found. Investigate table key schema / encoding mismatch.", {
                        clinicId,
                        table: CLINICS_TABLE,
                        foundItem: q.Items[0],
                    });
                    // Continue using the Query result rather than returning 404.
                    existing.Item = q.Items[0];
                }
            } catch (qErr) {
                console.error("[deleteClinic] Fallback Query failed", { error: (qErr as Error).message });
            }
        }

        if (!existing.Item) {
            console.warn("[deleteClinic] Returning 404 — clinic not found by GetItem OR Query", {
                clinicId,
                table: CLINICS_TABLE,
            });
            return json(event, 404, {
                error: "Not Found",
                statusCode: 404,
                message: "This clinic no longer exists. It may have already been permanently removed.",
                timestamp: new Date().toISOString(),
            });
        }

        if (existing.Item.deletedAt?.S) {
            return json(event, 409, {
                error: "Conflict",
                statusCode: 409,
                message:
                    "This clinic is already deleted and is waiting to be permanently removed. " +
                    "Open Settings → Restore Clinics to bring it back, or wait for permanent removal.",
                details: {
                    deletedAt: existing.Item.deletedAt.S,
                    purgeAt: existing.Item.ttl?.N
                        ? new Date(parseInt(existing.Item.ttl.N, 10) * 1000).toISOString()
                        : null,
                },
                timestamp: new Date().toISOString(),
            });
        }

        // Now the permission check. At this point we know the clinic exists
        // and isn't soft-deleted, so a false result is purely a role/membership
        // problem — accurate to surface as 403.
        const isAuthorized = await canWriteClinic(userSub, groups, clinicId, "manageClinic");
        if (!isAuthorized) {
            return json(event, 403, {
                error: "Forbidden",
                statusCode: 403,
                message:
                    "You are not authorized to delete this clinic. Root users can delete any clinic; ClinicAdmin and ClinicManager users can only delete clinics they are a member of.",
                details: { requiredGroup: ["Root", "ClinicAdmin", "ClinicManager"] },
                timestamp: new Date().toISOString(),
            });
        }

        const nowIso = new Date().toISOString();
        const ttlEpoch = Math.floor(Date.now() / 1000) + SOFT_DELETE_RETENTION_SECONDS;

        // Snapshot the display fields BEFORE soft-deleting, so the fallback UI on
        // the professional side has something to fall back to even after the
        // 30-day TTL fires and the row physically disappears.
        if (DELETED_CLINIC_SNAPSHOTS_TABLE) {
            try {
                const snapshotItem: Record<string, any> = {
                    clinicId: { S: clinicId },
                    deletedAt: { S: nowIso },
                    deletedBy: { S: userSub },
                };
                if (existing.Item.name?.S) snapshotItem.name = { S: existing.Item.name.S };
                if (existing.Item.officeImageKey?.S) {
                    snapshotItem.officeImageKey = { S: existing.Item.officeImageKey.S };
                }
                if (existing.Item.city?.S) snapshotItem.city = { S: existing.Item.city.S };
                if (existing.Item.state?.S) snapshotItem.state = { S: existing.Item.state.S };

                await dynamoClient.send(new PutItemCommand({
                    TableName: DELETED_CLINIC_SNAPSHOTS_TABLE,
                    Item: snapshotItem,
                }));
            } catch (snapErr) {
                console.warn("[deleteClinic] Failed to write snapshot (non-fatal):", (snapErr as Error).message);
            }
        }

        const updateInput: UpdateItemCommandInput = {
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            UpdateExpression: "SET deletedAt = :deletedAt, deletedBy = :deletedBy, #ttl = :ttl",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: {
                ":deletedAt": { S: nowIso },
                ":deletedBy": { S: userSub },
                ":ttl": { N: String(ttlEpoch) },
            },
        };

        await dynamoClient.send(new UpdateItemCommand(updateInput));

        return json(event, 200, {
            status: "success",
            statusCode: 200,
            message: "Clinic soft-deleted. It will be permanently removed in 30 days.",
            data: {
                clinicId,
                deletedAt: nowIso,
                purgeAt: new Date(ttlEpoch * 1000).toISOString(),
                restorable: true,
            },
            timestamp: nowIso,
        });
    } catch (error) {
        const err = error as Error & { message?: string };
        console.error("Error soft-deleting clinic:", err);

        return json(event, 500, {
            error: "Internal Server Error",
            statusCode: 500,
            message: "Failed to delete clinic",
            details: { reason: err.message },
            timestamp: new Date().toISOString(),
        });
    }
};

exports.handler = handler;
