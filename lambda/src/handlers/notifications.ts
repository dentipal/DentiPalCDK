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
} from "@aws-sdk/client-dynamodb";

export const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
export const NOTIFICATIONS_TABLE = process.env.NOTIFICATIONS_TABLE!;
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
    if (record.deepLink) item.deepLink = { S: record.deepLink };
    if (record.readAt) item.readAt = { S: record.readAt };
    if (record.expiresAt) item.expiresAt = { N: String(record.expiresAt) };
    return item;
}

/** Default TTL = now + 90 days, as a Unix epoch in seconds. */
export function defaultExpiresAt(now: number = Date.now()): number {
    return Math.floor(now / 1000) + NOTIFICATION_TTL_DAYS * 24 * 60 * 60;
}
