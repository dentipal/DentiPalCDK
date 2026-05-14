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
import { dynamo, resolveUserContact } from "./leadShared";

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

interface ProfessionalRow {
    subjectType: "professional";
    subjectId: string;          // userSub
    displayLabel: string;
    email?: string;             // resolved from Cognito (cached)
    secondary?: string;
    joinedAt?: string;
    banned: boolean;
    bannedAt?: string;
    banReason?: string;
}

/**
 * GET /admin/professionals — Admin only.
 *
 * Scans ProfessionalProfiles in pages, then BatchGetItem against the Bans
 * table for the page's userSubs to attach the `banned` flag in a single call.
 *
 * Query params:
 *   - search: post-filter substring match on name (lowercase)
 *   - limit:  page size (default 50, max 200)
 *   - cursor: base64 LastEvaluatedKey from a previous response
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    try {
        const caller = extractUserFromBearerToken(event.headers?.Authorization || event.headers?.authorization);
        // Admin + HR — both can view the directory so HR can onboard without
        // double-inviting users that already exist.
        if (!requireInternalGroup(caller.groups, ["Admin", "HR"])) {
            return json(event, 403, { error: "Forbidden", message: "Admin or HR role required." });
        }

        const qs = event.queryStringParameters || {};
        const search = (qs.search || "").toLowerCase().trim();
        const limit = Math.max(1, Math.min(200, parseInt(qs.limit || "50", 10) || 50));
        const cursor = decodeCursor(qs.cursor);

        const scan = await dynamo.send(new ScanCommand({
            TableName: process.env.PROFESSIONAL_PROFILES_TABLE!,
            Limit: limit,
            ExclusiveStartKey: cursor,
        }));

        // Map raw rows → flat shape the UI expects.
        let rows: ProfessionalRow[] = (scan.Items || []).map((raw) => {
            const item = unmarshall(raw) as Record<string, any>;
            const userSub = item.userSub as string;
            const fullName = (
                item.full_name ||
                [item.first_name, item.last_name].filter(Boolean).join(" ") ||
                ""
            ).trim();
            return {
                subjectType: "professional",
                subjectId: userSub,
                displayLabel: fullName || userSub,
                secondary: item.role || undefined,
                joinedAt: item.createdAt || item.created_at || undefined,
                banned: false,
            };
        });

        // Resolve email + name from Cognito for each row in parallel. Cached
        // per warm container so paginating the same list is essentially free
        // after the first call.
        await Promise.all(
            rows.map(async (row) => {
                const contact = await resolveUserContact(row.subjectId);
                row.email = contact.email || undefined;
                // Backfill displayLabel if the profile had no name on file.
                if (!row.displayLabel || row.displayLabel === row.subjectId) {
                    row.displayLabel = contact.name || row.subjectId;
                }
            })
        );

        // Substring search filter applied client-side over the page (now also matches email).
        if (search) {
            rows = rows.filter((row) => {
                const haystack = [row.displayLabel, row.secondary, row.email]
                    .filter(Boolean)
                    .join(" ")
                    .toLowerCase();
                return haystack.includes(search);
            });
        }

        // Join with Bans in a single BatchGetItem.
        if (rows.length > 0) {
            const banLookup = await dynamo.send(new BatchGetItemCommand({
                RequestItems: {
                    [process.env.BANS_TABLE!]: {
                        Keys: rows.map((r) => ({
                            subjectType: { S: "professional" },
                            subjectId: { S: r.subjectId },
                        })),
                    },
                },
            }));
            const banItems = banLookup.Responses?.[process.env.BANS_TABLE!] || [];
            const bansBySub = new Map<string, { bannedAt: string; reason?: string }>();
            for (const raw of banItems) {
                const ban = unmarshall(raw);
                bansBySub.set(ban.subjectId, { bannedAt: ban.bannedAt, reason: ban.reason });
            }
            rows = rows.map((row) => {
                const ban = bansBySub.get(row.subjectId);
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
        console.error("[listAdminProfessionals] error:", error);
        return json(event, 500, {
            error: "Internal Server Error",
            message: error?.message || "Failed to list professionals",
        });
    }
};
