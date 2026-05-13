/**
 * Event-to-Notification consumer.
 *
 * Subscribes to the same EventBridge rule that fans out shift/application/
 * negotiation events to the email + chat consumers. For each event, writes
 * one row into DentiPal-V5-Notifications for the recipient user so the bell
 * icon and notifications page can render it. Email opt-out preferences do
 * NOT gate the in-app feed — users mute via the bell or notification
 * settings page, not by skipping rows entirely.
 */

import { PutItemCommand } from "@aws-sdk/client-dynamodb";
import {
    ddb,
    NOTIFICATIONS_TABLE,
    NotificationRecord,
    NotificationType,
    generateNotificationId,
    recordToItem,
    defaultExpiresAt,
} from "./notifications";

interface EventBridgeEvent {
    detail: {
        eventType: string;
        clinicId?: string;
        clinicName?: string;
        professionalSub?: string;
        professionalName?: string;
        jobId?: string;
        applicationId?: string;
        negotiationId?: string;
        shiftDetails?: {
            date?: string;
            role?: string;
            rate?: number;
            startTime?: string;
        };
        // Free-form for events we don't formally model yet.
        [key: string]: any;
    };
}

interface NotificationDraft {
    recipientSub: string;
    type: NotificationType;
    title: string;
    body?: string;
    deepLink?: string;
    actorName?: string;
    subjectType?: string;
    subjectId?: string;
}

const PROFESSIONAL_DASHBOARD = "/professional-dashboard";
const PROFESSIONAL_JOBS = "/jobs";
const PROFESSIONAL_NEGOTIATIONS = "/negotiations";
const PROFESSIONAL_PROFILE = "/professional-profile";
const PROFESSIONAL_INBOX = "/professional-inbox";

/**
 * Map an EventBridge event to a notification row aimed at a single recipient.
 * Returns null if the event isn't (yet) something we surface in the feed —
 * keeps the consumer additive without breaking existing email/chat paths.
 */
function buildNotification(detail: EventBridgeEvent["detail"]): NotificationDraft | null {
    const eventType = detail.eventType || "";
    const proSub = detail.professionalSub;
    const clinicName = detail.clinicName || "Your clinic";
    const shift = detail.shiftDetails || {};
    const shiftLine = [shift.date, shift.role && `· ${shift.role}`, shift.rate && `· $${shift.rate}/hr`]
        .filter(Boolean)
        .join(" ")
        .trim();

    switch (eventType) {
        case "shift-scheduled":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_scheduled",
                title: `${clinicName} scheduled you for a shift`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-cancelled":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_cancelled",
                title: `${clinicName} cancelled your scheduled shift`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-modified":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_modified",
                title: `${clinicName} updated your shift details`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-completed":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_completed",
                title: `Your shift at ${clinicName} is marked complete`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-no-show":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_no_show",
                title: `${clinicName} reported a no-show`,
                body: "Please review and respond — action may be required.",
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-reminder-h24":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_reminder_h24",
                title: `Reminder: your shift at ${clinicName} starts in 24 hours`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "shift-reminder-h1":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "shift_reminder_h1",
                title: `Heads up: your shift at ${clinicName} starts in 1 hour`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "application-rejected":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "application_rejected",
                title: `Your application for ${clinicName} was declined`,
                body: "The clinic chose another candidate this time.",
                actorName: clinicName,
                deepLink: PROFESSIONAL_JOBS,
                subjectType: "application",
                subjectId: detail.applicationId,
            };

        case "invite-sent":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "invitation_received",
                title: `${clinicName} invited you to apply`,
                body: shiftLine || undefined,
                actorName: clinicName,
                deepLink: detail.jobId ? `${PROFESSIONAL_JOBS}/${detail.jobId}` : PROFESSIONAL_JOBS,
                subjectType: "job",
                subjectId: detail.jobId,
            };

        case "negotiation-counter":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "negotiation_counter",
                title: `${clinicName} sent you a counter offer`,
                body: shift.rate ? `Counter rate: $${shift.rate}/hr` : undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_NEGOTIATIONS,
                subjectType: "negotiation",
                subjectId: detail.negotiationId,
            };

        case "negotiation-accepted":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "negotiation_accepted",
                title: `${clinicName} accepted your counter offer`,
                body: shift.rate ? `Confirmed at $${shift.rate}/hr` : undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_NEGOTIATIONS,
                subjectType: "negotiation",
                subjectId: detail.negotiationId,
            };

        case "negotiation-declined":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "negotiation_declined",
                title: `${clinicName} declined your counter offer`,
                body: "They've moved on to other candidates.",
                actorName: clinicName,
                deepLink: PROFESSIONAL_NEGOTIATIONS,
                subjectType: "negotiation",
                subjectId: detail.negotiationId,
            };

        case "profile-viewed":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "profile_viewed",
                title: `${clinicName} viewed your profile`,
                actorName: clinicName,
                deepLink: PROFESSIONAL_PROFILE,
            };

        case "message-received":
            if (!proSub) return null;
            return {
                recipientSub: proSub,
                type: "message_received",
                title: `New message from ${clinicName}`,
                body: typeof detail.preview === "string" ? detail.preview : undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_INBOX,
            };

        default:
            return null;
    }
}

export const handler = async (
    event: EventBridgeEvent
): Promise<{ statusCode: number; reason?: string }> => {
    const detail = event?.detail;
    if (!detail || !detail.eventType) {
        return { statusCode: 200, reason: "no detail" };
    }

    const draft = buildNotification(detail);
    if (!draft) {
        return { statusCode: 200, reason: `unhandled event ${detail.eventType}` };
    }

    const record: NotificationRecord = {
        userSub: draft.recipientSub,
        notificationId: generateNotificationId(),
        type: draft.type,
        title: draft.title,
        body: draft.body,
        actorName: draft.actorName,
        subjectType: draft.subjectType,
        subjectId: draft.subjectId,
        deepLink: draft.deepLink,
        readAt: null,
        createdAt: new Date().toISOString(),
        expiresAt: defaultExpiresAt(),
    };

    try {
        await ddb.send(new PutItemCommand({
            TableName: NOTIFICATIONS_TABLE,
            Item: recordToItem(record),
        }));
        console.log("[event-to-notification] wrote", {
            eventType: detail.eventType,
            recipient: draft.recipientSub,
            type: draft.type,
        });
        return { statusCode: 200 };
    } catch (err: any) {
        console.error("[event-to-notification] write failed:", err);
        return { statusCode: 500, reason: err?.message || "write failed" };
    }
};
