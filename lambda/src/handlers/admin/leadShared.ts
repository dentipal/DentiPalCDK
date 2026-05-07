import { randomUUID } from "crypto";
import type { APIGatewayProxyEvent } from "aws-lambda";
import {
    DynamoDBClient,
    PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import {
    CognitoIdentityProviderClient,
    ListUsersCommand,
} from "@aws-sdk/client-cognito-identity-provider";
import type { InternalRole } from "../utils";

export const dynamo = new DynamoDBClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });
export const LEADS_TABLE = process.env.LEADS_TABLE!;
export const LEAD_ACTIVITY_TABLE = process.env.LEAD_ACTIVITY_TABLE!;

export const LEAD_STATUSES = [
    "new",
    "contacted",
    "qualified",
    "negotiating",
    "won",
    "lost",
] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export const LEAD_SOURCES = [
    "csv_upload",
    "manual",
    "referral",
    "event",
    "cold",
] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export const ACTIVITY_TYPES = [
    "note",
    "call",
    "status_change",
    "import",
] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];

export const CALL_DISPOSITIONS = [
    "left_voicemail",
    "spoke",
    "no_answer",
    "wrong_number",
    "do_not_call",
] as const;
export type CallDisposition = (typeof CALL_DISPOSITIONS)[number];

export interface LeadRecord {
    leadId: string;
    // All identity / contact fields optional — bulk-upload lets users dump
    // partial data and fill the gaps later. The single-lead create form still
    // validates these as required at its own boundary.
    clinicName?: string;
    contactFirstName?: string;
    contactLastName?: string;
    email?: string;
    phone?: string;
    city?: string;
    state?: string;
    source: LeadSource;
    status: LeadStatus;
    notes?: string;
    tags?: string[];
    createdBy: string;
    createdByName?: string;
    createdAt: string;
    updatedAt: string;
    lastActivityAt: string;
}

/**
 * Sortable activityId — ISO-prefixed so SK comparison gives chronological order
 * even without a dedicated GSI on createdAt within a lead.
 */
export const newActivityId = (createdAt: string): string =>
    `${createdAt}#${randomUUID()}`;

/**
 * Extract a path segment that follows a known marker.
 *
 * The REST API uses an APIGW `/{proxy+}` catch-all integration, so
 * `event.pathParameters` only contains `{ proxy: "admin/leads/<id>" }` — never
 * the typed `leadId` we'd get from a fully-resourced route definition. We
 * fall back to parsing the actual path segments, which works regardless of
 * whether there's a trailing /activity, /status, etc.
 */
export const getPathSegmentAfter = (event: APIGatewayProxyEvent, marker: string): string | undefined => {
    // Try typed param first — covers any future move to explicit resources.
    const typed = (event.pathParameters as Record<string, string | undefined> | null | undefined)?.[marker === "leads" ? "leadId" : marker];
    if (typed) return typed;

    const candidates = [
        event.path,
        event.requestContext?.resourcePath,
        event.pathParameters?.proxy,
    ].filter((s): s is string => typeof s === "string" && s.length > 0);

    for (const candidate of candidates) {
        const segments = candidate.split("/").filter(Boolean);
        const idx = segments.indexOf(marker);
        if (idx >= 0 && segments[idx + 1]) return segments[idx + 1];
    }
    return undefined;
};

/** Convenience wrapper used by every lead handler. */
export const getLeadIdFromEvent = (event: APIGatewayProxyEvent): string | undefined =>
    getPathSegmentAfter(event, "leads");

export const isLeadStatus = (s: unknown): s is LeadStatus =>
    typeof s === "string" && (LEAD_STATUSES as readonly string[]).includes(s);

export const isLeadSource = (s: unknown): s is LeadSource =>
    typeof s === "string" && (LEAD_SOURCES as readonly string[]).includes(s);

export const isActivityType = (s: unknown): s is ActivityType =>
    typeof s === "string" && (ACTIVITY_TYPES as readonly string[]).includes(s);

export const isCallDisposition = (s: unknown): s is CallDisposition =>
    typeof s === "string" && (CALL_DISPOSITIONS as readonly string[]).includes(s);

export interface ActivityWriteInput {
    leadId: string;
    type: ActivityType;
    performedBy: string;
    performedByName?: string;
    content?: string;
    callDisposition?: CallDisposition;
    previousValue?: string;
    newValue?: string;
}

/**
 * Append a row to LeadActivity. Caller is expected to have already validated
 * fields; this is a thin marshalling helper to keep the per-action handlers small.
 */
export const writeActivity = async (input: ActivityWriteInput): Promise<{ activityId: string; createdAt: string }> => {
    const createdAt = new Date().toISOString();
    const activityId = newActivityId(createdAt);
    const item: Record<string, any> = {
        leadId: input.leadId,
        activityId,
        type: input.type,
        performedBy: input.performedBy,
        createdAt,
    };
    if (input.performedByName) item.performedByName = input.performedByName;
    if (input.content) item.content = input.content;
    if (input.callDisposition) item.callDisposition = input.callDisposition;
    if (input.previousValue !== undefined) item.previousValue = input.previousValue;
    if (input.newValue !== undefined) item.newValue = input.newValue;
    await dynamo.send(new PutItemCommand({
        TableName: LEAD_ACTIVITY_TABLE,
        Item: marshall(item, { removeUndefinedValues: true }),
    }));
    return { activityId, createdAt };
};

/**
 * Best-effort display name for an activity's performedByName field. JWTs may
 * carry email, given_name, etc. — fall back to the email handle if nothing else.
 *
 * Note: Cognito access tokens do NOT include given_name / family_name / email
 * by default (those are on the id token). For accurate names use
 * `resolveDisplayName(sub)` instead, which queries Cognito.
 */
export const displayNameFromClaims = (claims: { email?: string; sub?: string; [k: string]: any }): string => {
    const given = claims.given_name || "";
    const family = claims.family_name || "";
    const full = `${given} ${family}`.trim();
    if (full) return full;
    if (typeof claims.email === "string" && claims.email.includes("@")) {
        return claims.email.split("@")[0];
    }
    return claims.sub || "Unknown";
};

/** Single warm-container cache so we don't re-query Cognito for the same sub. */
const displayNameCache = new Map<string, string>();

/** Cache of `{ name, email }` keyed by sub. Filled by resolveUserContact. */
const userContactCache = new Map<string, { name: string; email: string }>();

/**
 * Resolve a Cognito user's display name from their sub.
 *
 * Used when writing lead / activity rows so `createdByName` and `performedByName`
 * carry a human-readable string instead of the sub UUID. Falls back to the email
 * handle, then to the sub itself if nothing else is available.
 *
 * Uses ListUsers with a `sub = "..."` filter — works regardless of whether the
 * pool's Username is the email or the sub-formatted UUID.
 */
/**
 * Resolve a Cognito user's name + email from their sub.
 *
 * Used by the admin user-directory listing handlers so each row carries the
 * user's email without a per-row round-trip on the frontend. Same `ListUsers`
 * trick as resolveDisplayName, but returns more fields. Caches on a separate
 * map keyed by sub.
 */
export const resolveUserContact = async (sub: string): Promise<{ name: string; email: string }> => {
    if (!sub) return { name: "Unknown", email: "" };
    const cached = userContactCache.get(sub);
    if (cached) return cached;
    try {
        const resp = await cognito.send(new ListUsersCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Filter: `sub = "${sub}"`,
            Limit: 1,
        }));
        const user = resp.Users?.[0];
        const attrs = user?.Attributes || [];
        const attr = (name: string) => attrs.find(a => a.Name === name)?.Value || "";
        const given = attr("given_name");
        const family = attr("family_name");
        const email = attr("email");
        const full = `${given} ${family}`.trim();
        const name = full || (email && email.includes("@") ? email.split("@")[0] : sub);
        const resolved = { name, email };
        userContactCache.set(sub, resolved);
        // Keep displayNameCache in sync so resolveDisplayName benefits too.
        displayNameCache.set(sub, name);
        return resolved;
    } catch (err) {
        console.warn("[resolveUserContact] failed for sub", sub, err);
        return { name: sub, email: "" };
    }
};

export const resolveDisplayName = async (sub: string): Promise<string> => {
    if (!sub) return "Unknown";
    const cached = displayNameCache.get(sub);
    if (cached) return cached;
    try {
        const resp = await cognito.send(new ListUsersCommand({
            UserPoolId: process.env.USER_POOL_ID!,
            Filter: `sub = "${sub}"`,
            Limit: 1,
        }));
        const user = resp.Users?.[0];
        const attrs = user?.Attributes || [];
        const attr = (name: string) => attrs.find(a => a.Name === name)?.Value || "";
        const given = attr("given_name");
        const family = attr("family_name");
        const full = `${given} ${family}`.trim();
        let resolved: string;
        if (full) {
            resolved = full;
        } else {
            const email = attr("email");
            resolved = email && email.includes("@") ? email.split("@")[0] : sub;
        }
        displayNameCache.set(sub, resolved);
        return resolved;
    } catch (err) {
        console.warn("[resolveDisplayName] failed for sub", sub, err);
        return sub;
    }
};

/** Roles that can mutate lead state (status changes, edits, activity). */
export const LEAD_WRITE_ROLES: readonly InternalRole[] = ["Admin", "Sales"];

/** Roles that can create / upload leads. */
export const LEAD_CREATE_ROLES: readonly InternalRole[] = ["Admin", "Sales", "Marketing"];

/** Roles that can bulk-upload leads (CSV import). */
export const LEAD_BULK_UPLOAD_ROLES: readonly InternalRole[] = ["Admin", "Marketing"];
