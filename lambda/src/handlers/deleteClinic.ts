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

    if (method === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        const userInfo = extractUserFromBearerToken(authHeader);
        const userSub = userInfo.sub;
        const groups = userInfo.groups;

        const clinicId: string | undefined =
            event.pathParameters?.clinicId || event.pathParameters?.proxy;

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
        const existing = await dynamoClient.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        }));

        if (!existing.Item) {
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
