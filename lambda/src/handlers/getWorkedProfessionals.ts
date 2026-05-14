import {
    DynamoDBClient,
    QueryCommand,
    GetItemCommand,
    QueryCommandInput,
    QueryCommandOutput,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

import { extractUserFromBearerToken, canAccessClinic } from "./utils";
import { corsHeaders } from "./corsHeaders";

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE;
const JOB_APPLICATIONS_CLINIC_GSI =
    process.env.JOB_APPLICATIONS_CLINIC_GSI || "clinicId-jobId-index";
const CLINICS_TABLE = process.env.CLINICS_TABLE;

const parseNumOrNull = (attr?: AttributeValue): number | null => {
    if (!attr || !("N" in attr) || typeof attr.N !== "string") return null;
    const v = parseFloat(attr.N);
    return Number.isFinite(v) ? v : null;
};

// Only count strictly "worked" outcomes — paid follows completed in the
// status machine, both mean the professional actually delivered the shift.
// No-show is excluded: the professional did not work there.
const WORKED_STATUSES = new Set(["completed", "paid"]);

export const handler = async (
    event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    if (event && event.httpMethod === "OPTIONS") {
        return { statusCode: 204, headers: corsHeaders(event), body: "" };
    }

    try {
        let userSub: string;
        let userGroups: string[];
        try {
            const authHeader = event.headers?.Authorization || event.headers?.authorization;
            const userInfo = extractUserFromBearerToken(authHeader);
            userSub = userInfo.sub;
            userGroups = userInfo.groups || [];
        } catch (authError: any) {
            return {
                statusCode: 401,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: authError.message || "Invalid access token" }),
            };
        }

        // API Gateway uses a {proxy+} catch-all integration, so the named
        // {clinicId} placeholder is not populated on pathParameters. We try
        // every source in order: explicit clinicId, proxy split, then a
        // direct regex on the raw request path (the most reliable fallback).
        let clinicId = event.pathParameters?.clinicId || "";
        if (!clinicId) {
            const proxy = event.pathParameters?.proxy || "";
            const proxyParts = proxy.split("/").filter(Boolean);
            if (proxyParts.length >= 2 && proxyParts[0] === "clinics") {
                clinicId = proxyParts[1];
            }
        }
        if (!clinicId) {
            const rawPath: string =
                event.path ||
                (event as any).rawPath ||
                event.resource ||
                "";
            const match = rawPath.match(/\/clinics\/([^\/]+)\/worked-professionals/);
            if (match) clinicId = match[1];
        }

        if (!clinicId) {
            return {
                statusCode: 400,
                headers: corsHeaders(event),
                body: JSON.stringify({
                    error: "clinicId path parameter is required",
                    debug: {
                        path: event.path,
                        resource: event.resource,
                        pathParameters: event.pathParameters,
                    },
                }),
            };
        }

        const allowed = await canAccessClinic(userSub, userGroups, clinicId);
        if (!allowed) {
            return {
                statusCode: 403,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: "You do not have access to this clinic" }),
            };
        }

        if (!JOB_APPLICATIONS_TABLE) {
            return {
                statusCode: 500,
                headers: corsHeaders(event),
                body: JSON.stringify({ error: "JOB_APPLICATIONS_TABLE env var is not set" }),
            };
        }

        const seen = new Set<string>();
        let ExclusiveStartKey: Record<string, AttributeValue> | undefined = undefined;

        do {
            const input: QueryCommandInput = {
                TableName: JOB_APPLICATIONS_TABLE,
                IndexName: JOB_APPLICATIONS_CLINIC_GSI,
                KeyConditionExpression: "clinicId = :cId",
                ExpressionAttributeValues: { ":cId": { S: clinicId } },
                ProjectionExpression: "professionalUserSub, applicationStatus",
                ExclusiveStartKey,
            };

            const res: QueryCommandOutput = await dynamodb.send(new QueryCommand(input));

            for (const item of res.Items || []) {
                const status = (item.applicationStatus?.S || "").toLowerCase();
                if (!WORKED_STATUSES.has(status)) continue;

                const sub = item.professionalUserSub?.S;
                if (sub) seen.add(sub);
            }

            ExclusiveStartKey = res.LastEvaluatedKey;
        } while (ExclusiveStartKey);

        // Also fetch the clinic's geocoded coordinates so the frontend can
        // distance-sort professionals relative to this clinic without an
        // extra round-trip. Best-effort: a missing clinic record or missing
        // lat/lng just yields nulls — the frontend falls back to no sort.
        let clinicLat: number | null = null;
        let clinicLng: number | null = null;
        if (CLINICS_TABLE) {
            try {
                const clinicRes = await dynamodb.send(new GetItemCommand({
                    TableName: CLINICS_TABLE,
                    Key: { clinicId: { S: clinicId } },
                    ProjectionExpression: "lat, lng",
                }));
                clinicLat = parseNumOrNull(clinicRes.Item?.lat);
                clinicLng = parseNumOrNull(clinicRes.Item?.lng);
            } catch (e) {
                console.warn("[getWorkedProfessionals] Failed to load clinic coords:", e);
            }
        }

        return {
            statusCode: 200,
            headers: corsHeaders(event),
            body: JSON.stringify({
                clinicId,
                professionalUserSubs: Array.from(seen),
                count: seen.size,
                clinicLat,
                clinicLng,
            }),
        };
    } catch (error) {
        const err = error as Error;
        console.error("[getWorkedProfessionals] Error:", err);
        return {
            statusCode: 500,
            headers: corsHeaders(event),
            body: JSON.stringify({ error: err.message }),
        };
    }
};
