import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import {
    BatchGetItemCommand,
    ScanCommand,
    type AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { unmarshall } from "@aws-sdk/util-dynamodb";
import { corsHeaders } from "../corsHeaders";
import {
    extractUserFromBearerToken,
    requireInternalGroup,
} from "../utils";
import { dynamo, resolveDisplayName } from "./leadShared";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

const encodeCursor = (key: Record<string, AttributeValue> | undefined): string | null =>
    key ? Buffer.from(JSON.stringify(key)).toString("base64") : null;

const decodeCursor = (cursor: string | undefined): Record<string, AttributeValue> | undefined => {
    if (!cursor) return undefined;
    try {
        return JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
    } catch {
        return undefined;
    }
};

interface ClinicRow {
    subjectType: "clinic";
    subjectId: string;          // clinicId
    ownerSub: string;
    ownerName?: string;         // resolved via Cognito
    displayLabel: string;       // clinic name
    secondary?: string;         // city, state
    joinedAt?: string;
    banned: boolean;
    bannedAt?: string;
    banReason?: string;
}

/**
 * GET /admin/clinics — Admin only.
 *
 * Scans Clinics, joins with Bans (subjectType = "clinic"), resolves the owner's
 * display name via the cached resolveDisplayName helper. Returns a flat row
 * shape suitable for the directory table.
 *
 * Owner-name resolution is what makes the BanModal copy possible ("the owner,
 * <name>, will be unable to sign in") — without it the modal would show the
 * raw createdBy sub.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        // Admin + HR — both can view the directory so HR can onboard without
        // double-inviting clinics that already exist.
        if (!requireInternalGroup(caller.groups, ["Admin", "HR"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin or HR role required." });
        }

        const qs = event.queryStringParameters || {};
        const search = (qs.search || "").toLowerCase().trim();
        const limit = Math.max(1, Math.min(200, parseInt(qs.limit || "50", 10) || 50));
        const cursor = decodeCursor(qs.cursor);

        const scan = await dynamo.send(new ScanCommand({
            TableName: process.env.CLINICS_TABLE!,
            Limit: limit,
            ExclusiveStartKey: cursor,
        }));

        let rows: ClinicRow[] = (scan.Items || [])
            .map((raw) => unmarshall(raw) as Record<string, any>)
            .filter((item) => item.clinicId && item.createdBy)
            .map((item) => {
                const city = item.city || "";
                const state = item.state || "";
                const secondary = [city, state].filter(Boolean).join(", ") || undefined;
                return {
                    subjectType: "clinic" as const,
                    subjectId: item.clinicId,
                    ownerSub: item.createdBy,
                    displayLabel: item.name || item.clinicId,
                    secondary,
                    joinedAt: item.createdAt || undefined,
                    banned: false,
                };
            });

        // Substring search on the page (clinic name, city, state).
        if (search) {
            rows = rows.filter((row) => {
                const haystack = [row.displayLabel, row.secondary].filter(Boolean).join(" ").toLowerCase();
                return haystack.includes(search);
            });
        }

        // Resolve owner display names in parallel — cached per warm container so
        // listing the same page repeatedly is essentially free after the first call.
        await Promise.all(
            rows.map(async (row) => {
                row.ownerName = await resolveDisplayName(row.ownerSub);
            })
        );

        // Join with Bans in a single BatchGetItem.
        if (rows.length > 0) {
            const banLookup = await dynamo.send(new BatchGetItemCommand({
                RequestItems: {
                    [process.env.BANS_TABLE!]: {
                        Keys: rows.map((r) => ({
                            subjectType: { S: "clinic" },
                            subjectId: { S: r.subjectId },
                        })),
                    },
                },
            }));
            const banItems = banLookup.Responses?.[process.env.BANS_TABLE!] || [];
            const bansById = new Map<string, { bannedAt: string; reason?: string }>();
            for (const raw of banItems) {
                const ban = unmarshall(raw);
                bansById.set(ban.subjectId, { bannedAt: ban.bannedAt, reason: ban.reason });
            }
            rows = rows.map((row) => {
                const ban = bansById.get(row.subjectId);
                if (!ban) return row;
                return { ...row, banned: true, bannedAt: ban.bannedAt, banReason: ban.reason };
            });
        }

        return json(event, 200, {
            status: "success",
            data: {
                rows,
                nextCursor: encodeCursor(scan.LastEvaluatedKey),
                count: rows.length,
            },
        });
    } catch (error: any) {
        console.error("[listAdminClinics] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to list clinics",
        });
    }
};
