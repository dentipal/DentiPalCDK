/**
 * Shared utilities for the in-app notifications feed.
 *
 * The Notifications table is the message-history table that backs the bell
 * icon and `/professional-notifications` page in the frontend. Each row is
 * one user-visible event (a shift scheduled, an invitation, a counter offer
 * received). Settings still live in DentiPal-V5-NotificationPreferences.
 */

import {
    DynamoDBClient,
    AttributeValue,
    GetItemCommand,
} from "@aws-sdk/client-dynamodb";

export const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
export const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE!;
/** Optional — only required by the event consumer that fans out to clinic teams. */
export const CLINICS_TABLE = process.env.CLINICS_TABLE;
export const ddb = new DynamoDBClient({ region: REGION });

/** Auto-expiry window for notification rows. Keeps the table from growing
 *  unbounded; users still keep email records for older events. */
export const NOTIFICATION_TTL_DAYS = 90;

/**
 * The notification types the frontend understands. Keep this enum in sync
 * with `dentipal/src/api/notifications.ts` `NotificationType`.
 */
export type NotificationType =
    | "shift_scheduled"
    | "shift_cancelled"
    | "shift_modified"
    | "shift_completed"
    | "shift_no_show"
    | "shift_reminder_h24"
    | "shift_reminder_h1"
    | "job_modified"
    | "application_received"
    | "application_rejected"
    | "invitation_received"
    | "invitation_response"
    | "negotiation_counter"
    | "negotiation_accepted"
    | "negotiation_declined"
    | "profile_viewed"
    | "message_received"
    | "no_show_reported"
    | "system";

export interface NotificationRecord {
    userSub: string;
    notificationId: string;
    type: NotificationType;
    title: string;
    body?: string;
    actorSub?: string;
    actorName?: string;
    subjectType?: string;
    subjectId?: string;
    /** ID of the clinic this notification is about. Stored separately from
     *  subjectId so the frontend can construct clinic-scoped URLs (the
     *  JobApplicantsPage hangs without `?clinicId=`) even when subjectId
     *  refers to a different entity (jobId, applicationId, negotiationId). */
    clinicId?: string;
    deepLink?: string;
    readAt: string | null;
    createdAt: string;
    expiresAt?: number; // Unix epoch seconds, fed to DynamoDB TTL
}

/**
 * Build a sortable notification ID. The leading 13-char zero-padded epoch
 * means newer IDs sort lexicographically after older ones, so a single
 * Query with `ScanIndexForward: false` returns reverse-chronological order
 * without needing a GSI.
 */
export function generateNotificationId(now: number = Date.now()): string {
    const epoch = String(now).padStart(13, "0");
    const random = Math.random().toString(36).substring(2, 10);
    return `${epoch}#${random}`;
}

/** Convert a DynamoDB item into the JSON shape the frontend expects. */
export function itemToRecord(item: Record<string, AttributeValue>): NotificationRecord {
    return {
        userSub: item.userSub?.S || "",
        notificationId: item.notificationId?.S || "",
        type: (item.type?.S || "system") as NotificationType,
        title: item.title?.S || "",
        body: item.body?.S,
        actorSub: item.actorSub?.S,
        actorName: item.actorName?.S,
        subjectType: item.subjectType?.S,
        subjectId: item.subjectId?.S,
        clinicId: item.clinicId?.S,
        deepLink: item.deepLink?.S,
        readAt: item.readAt?.S || null,
        createdAt: item.createdAt?.S || "",
        expiresAt: item.expiresAt?.N ? Number(item.expiresAt.N) : undefined,
    };
}

/** Convert a record into a DynamoDB item ready for PutItem. */
export function recordToItem(record: NotificationRecord): Record<string, AttributeValue> {
    const item: Record<string, AttributeValue> = {
        userSub: { S: record.userSub },
        notificationId: { S: record.notificationId },
        type: { S: record.type },
        title: { S: record.title },
        createdAt: { S: record.createdAt },
    };
    if (record.body) item.body = { S: record.body };
    if (record.actorSub) item.actorSub = { S: record.actorSub };
    if (record.actorName) item.actorName = { S: record.actorName };
    if (record.subjectType) item.subjectType = { S: record.subjectType };
    if (record.subjectId) item.subjectId = { S: record.subjectId };
    if (record.clinicId) item.clinicId = { S: record.clinicId };
    if (record.deepLink) item.deepLink = { S: record.deepLink };
    if (record.readAt) item.readAt = { S: record.readAt };
    if (record.expiresAt) item.expiresAt = { N: String(record.expiresAt) };
    return item;
}

/** Default TTL = now + 90 days, as a Unix epoch in seconds. */
export function defaultExpiresAt(now: number = Date.now()): number {
    return Math.floor(now / 1000) + NOTIFICATION_TTL_DAYS * 24 * 60 * 60;
}

/**
 * Extract user subs from the `AssociatedUsers` attribute on a Clinics row.
 * The attribute has been written historically as StringSet (SS), List of {S}
 * (L), or a single String (S) — accept all three shapes so notification
 * fan-out doesn't silently miss team members.
 */
function extractAssociatedUsers(attr: AttributeValue | undefined): string[] {
    if (!attr) return [];
    const a = attr as any;
    if (Array.isArray(a.SS)) return a.SS as string[];
    if (Array.isArray(a.L)) {
        return (a.L as any[])
            .map((v) => (v && typeof v.S === "string" ? v.S : null))
            .filter((v): v is string => !!v);
    }
    if (typeof a.S === "string") return [a.S];
    return [];
}

/**
 * Resolve the full clinic-team for a clinicId — every user who can see the
 * clinic's data (Clinics.createdBy + Clinics.AssociatedUsers). One point-read
 * on the Clinics table, no scan. Returns `[]` if the clinic record is missing,
 * the table env var isn't wired, or the read fails — callers should treat an
 * empty list as "no clinic recipients" and skip writing rows rather than
 * blowing up the consumer.
 *
 * This is the same membership definition used by canAccessClinic() in utils.ts;
 * a user who can't read the clinic also shouldn't receive its notifications.
 */
export async function getClinicRecipientSubs(clinicId: string): Promise<string[]> {
    if (!clinicId || !CLINICS_TABLE) return [];
    try {
        const res = await ddb.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
            ProjectionExpression: "AssociatedUsers, createdBy",
        }));
        if (!res.Item) return [];
        const subs = new Set<string>();
        const createdBy = res.Item.createdBy?.S;
        if (createdBy) subs.add(createdBy);
        for (const sub of extractAssociatedUsers(res.Item.AssociatedUsers)) {
            if (sub) subs.add(sub);
        }
        return Array.from(subs);
    } catch (err) {
        console.error("[getClinicRecipientSubs] read failed for", clinicId, err);
        return [];
    }
}
