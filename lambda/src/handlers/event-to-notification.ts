/**
 * Event-to-Notification consumer.
 *
 * Subscribes to the same EventBridge rule that fans out shift/application/
 * negotiation events to the email + chat consumers. For each event, writes
 * one row into DentiPal-V5-Notifications per recipient so the bell icon and
 * notifications page can render it. Email opt-out preferences do NOT gate
 * the in-app feed — users mute via the bell or notification settings page,
 * not by skipping rows entirely.
 *
 * Per event we may produce:
 *   - A professional-side row (recipientSub = professionalSub) with a
 *     /professional-* deepLink, OR
 *   - One row per clinic team member (resolved via getClinicRecipientSubs)
 *     with a clinic-side deepLink, OR
 *   - Both, when the event is interesting to both sides (e.g. shift-completed).
 *
 * The `actor` field on the event detail tells us who *did* the thing, so we
 * don't write a row back to the same user who triggered it.
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
    getClinicRecipientSubs,
} from "./notifications";

interface EventBridgeEvent {
    detail: {
        eventType: string;
        /** Who took the action: "clinic" or "professional". Optional — when missing
         *  we fall back to the historical pro-only behaviour for backwards compat. */
        actor?: "clinic" | "professional";
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
const PROFESSIONAL_DASHBOARD_PENDING = "/professional-dashboard?tab=pending";
const PROFESSIONAL_DASHBOARD_SCHEDULED = "/professional-dashboard?tab=scheduled";
const PROFESSIONAL_DASHBOARD_COMPLETED = "/professional-dashboard?tab=completed";
const PROFESSIONAL_DASHBOARD_INVITES = "/professional-dashboard?tab=invites";
const PROFESSIONAL_PROFILE = "/professional-profile";
const PROFESSIONAL_INBOX = "/professional-inbox";

const CLINIC_DASHBOARD = "/clinic-dashboard";
const CLINIC_INBOX = "/clinic-inbox";
const CLINIC_NEGOTIATIONS = "/negotiations";
const CLINIC_PROFILE = "/clinic-profile";

/** Build the clinic-side deepLink for a job-scoped event. Falls back to the
 *  clinic dashboard if the jobId is missing. */
function clinicJobDeepLink(jobId: string | undefined): string {
    if (!jobId) return CLINIC_DASHBOARD;
    return `/jobs/${encodeURIComponent(jobId)}/applicants`;
}

/** Build the clinic-side deepLink for a negotiation event. Threads the
 *  application/negotiation/job id through so the page can scroll-and-highlight. */
function clinicNegotiationDeepLink(
    negotiationId?: string,
    applicationId?: string,
    jobId?: string
): string {
    if (negotiationId) return `${CLINIC_NEGOTIATIONS}?negotiationId=${encodeURIComponent(negotiationId)}`;
    if (applicationId) return `${CLINIC_NEGOTIATIONS}?applicationId=${encodeURIComponent(applicationId)}`;
    if (jobId) return `${CLINIC_NEGOTIATIONS}?jobId=${encodeURIComponent(jobId)}`;
    return CLINIC_NEGOTIATIONS;
}

function shiftLineFrom(detail: EventBridgeEvent["detail"]): string {
    const shift = detail.shiftDetails || {};
    return [shift.date, shift.role && `· ${shift.role}`, shift.rate && `· $${shift.rate}/hr`]
        .filter(Boolean)
        .join(" ")
        .trim();
}

/**
 * Resolve clinic recipients for an event, excluding the actor (so a clinic
 * user who themselves cancelled a job doesn't get their own notification).
 */
async function clinicRecipientsExcludingActor(
    clinicId: string | undefined,
    actorSub: string | undefined
): Promise<string[]> {
    if (!clinicId) return [];
    const all = await getClinicRecipientSubs(clinicId);
    if (!actorSub) return all;
    return all.filter((sub) => sub !== actorSub);
}

/**
 * Map an EventBridge event to one or more notification drafts. Returns `[]`
 * for events we don't surface in the feed — keeps the consumer additive.
 *
 * The async flavour exists so clinic-team resolution (single GetItem against
 * the Clinics table) happens inline; the read is bounded and idempotent.
 */
async function buildNotifications(detail: EventBridgeEvent["detail"]): Promise<NotificationDraft[]> {
    const eventType = detail.eventType || "";
    const proSub = detail.professionalSub;
    const clinicName = detail.clinicName || "Your clinic";
    const proName = detail.professionalName || "A professional";
    const shiftLine = shiftLineFrom(detail);
    const drafts: NotificationDraft[] = [];

    // Pro-acted clinic-recipient events use `clinicActorSub` to skip self-notify;
    // for events the pro triggers there's no clinic actor to exclude.
    const clinicActorSub: string | undefined = typeof detail.clinicActorSub === "string"
        ? detail.clinicActorSub
        : undefined;

    switch (eventType) {
        // -------------------------------------------------------------------
        // Shift lifecycle — clinic acts, professional is the audience.
        // -------------------------------------------------------------------
        case "shift-scheduled":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_scheduled",
                    title: `${clinicName} scheduled you for a shift`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_SCHEDULED,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;

        case "shift-cancelled":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_cancelled",
                    title: `${clinicName} cancelled your scheduled shift`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;

        case "shift-modified":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_modified",
                    title: `${clinicName} updated your shift details`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_SCHEDULED,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;

        case "shift-completed": {
            // Pro audience — confirmation their shift is closed.
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_completed",
                    title: `Your shift at ${clinicName} is marked complete`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_COMPLETED,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            // Clinic audience — payroll/audit visibility for the rest of the team.
            const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, clinicActorSub);
            for (const sub of clinicRecipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "shift_completed",
                    title: `${proName} completed a shift`,
                    body: shiftLine || undefined,
                    actorName: proName,
                    deepLink: clinicJobDeepLink(detail.jobId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;
        }

        case "shift-no-show": {
            // Pro audience — the no-show was reported against them, action required.
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_no_show",
                    title: `${clinicName} reported a no-show`,
                    body: "Please review and respond — action may be required.",
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            // Clinic audience — confirmation the report was recorded for everyone
            // on the team (so other admins know without re-checking).
            const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, clinicActorSub);
            for (const sub of clinicRecipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "no_show_reported",
                    title: `No-show reported for ${proName}`,
                    body: shiftLine || undefined,
                    actorName: proName,
                    deepLink: clinicJobDeepLink(detail.jobId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;
        }

        case "shift-reminder-h24":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_reminder_h24",
                    title: `Reminder: your shift at ${clinicName} starts in 24 hours`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_SCHEDULED,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            // Also remind the clinic team so the front desk can prepare.
            {
                const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
                for (const sub of clinicRecipients) {
                    drafts.push({
                        recipientSub: sub,
                        type: "shift_reminder_h24",
                        title: `${proName} starts a shift in 24 hours`,
                        body: shiftLine || undefined,
                        actorName: proName,
                        deepLink: clinicJobDeepLink(detail.jobId),
                        subjectType: "job",
                        subjectId: detail.jobId,
                    });
                }
            }
            return drafts;

        case "shift-reminder-h1":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "shift_reminder_h1",
                    title: `Heads up: your shift at ${clinicName} starts in 1 hour`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_SCHEDULED,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            {
                const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
                for (const sub of clinicRecipients) {
                    drafts.push({
                        recipientSub: sub,
                        type: "shift_reminder_h1",
                        title: `${proName} starts a shift in 1 hour`,
                        body: shiftLine || undefined,
                        actorName: proName,
                        deepLink: clinicJobDeepLink(detail.jobId),
                        subjectType: "job",
                        subjectId: detail.jobId,
                    });
                }
            }
            return drafts;

        // -------------------------------------------------------------------
        // Job edits — clinic acts, fan-out is one event per pro recipient
        // already (notifyJobChanged.ts). Clinic side does NOT get notified
        // because the actor IS the clinic team.
        // -------------------------------------------------------------------
        case "job-modified": {
            if (!proSub) return drafts;
            const changedFields = typeof detail.changedFields === "string" ? detail.changedFields : "";
            const bodyParts = [shiftLine, changedFields ? `Changed: ${changedFields}` : ""].filter(Boolean);
            drafts.push({
                recipientSub: proSub,
                type: "job_modified",
                title: `${clinicName} updated a job you're tracking`,
                body: bodyParts.join(" · ") || undefined,
                actorName: clinicName,
                deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                subjectType: "job",
                subjectId: detail.jobId,
            });
            return drafts;
        }

        // -------------------------------------------------------------------
        // Application lifecycle.
        // -------------------------------------------------------------------
        case "application-received": {
            // Pro applied → fan out to the clinic team. Pro side already saw
            // their submission go through; no row for them.
            const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
            for (const sub of clinicRecipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "application_received",
                    title: `${proName} applied to your job`,
                    body: shiftLine || undefined,
                    actorName: proName,
                    deepLink: clinicJobDeepLink(detail.jobId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;
        }

        case "application-rejected":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "application_rejected",
                    title: `Your application for ${clinicName} was declined`,
                    body: "The clinic chose another candidate this time.",
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                    subjectType: "application",
                    subjectId: detail.applicationId,
                });
            }
            return drafts;

        // -------------------------------------------------------------------
        // Invitations — clinic invites pro, pro responds.
        // -------------------------------------------------------------------
        case "invite-sent":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "invitation_received",
                    title: `${clinicName} invited you to apply`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_INVITES,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;

        case "invite-accepted":
        case "invite-declined":
        case "invite-negotiating": {
            const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
            const verb =
                eventType === "invite-accepted" ? "accepted"
                    : eventType === "invite-declined" ? "declined"
                        : "started negotiating";
            for (const sub of clinicRecipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "invitation_response",
                    title: `${proName} ${verb} your invitation`,
                    body: shiftLine || undefined,
                    actorName: proName,
                    deepLink: clinicJobDeepLink(detail.jobId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;
        }

        // -------------------------------------------------------------------
        // Negotiations — both directions. The `actor` field tells us who
        // sent it; we write a row for the OTHER side.
        // -------------------------------------------------------------------
        case "negotiation-counter":
        case "negotiation-accepted":
        case "negotiation-declined": {
            const type: NotificationType =
                eventType === "negotiation-counter" ? "negotiation_counter"
                    : eventType === "negotiation-accepted" ? "negotiation_accepted"
                        : "negotiation_declined";
            const verbToPro =
                eventType === "negotiation-counter" ? "sent you a counter offer"
                    : eventType === "negotiation-accepted" ? "accepted your counter offer"
                        : "declined your counter offer";
            const verbToClinic =
                eventType === "negotiation-counter" ? "sent a counter offer"
                    : eventType === "negotiation-accepted" ? "accepted your offer"
                        : "declined your offer";

            // Clinic was the actor → pro is the audience.
            if (detail.actor === "clinic" && proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type,
                    title: `${clinicName} ${verbToPro}`,
                    body: detail.shiftDetails?.rate
                        ? (eventType === "negotiation-accepted" ? `Confirmed at $${detail.shiftDetails.rate}/hr` : `Counter rate: $${detail.shiftDetails.rate}/hr`)
                        : undefined,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                    subjectType: "negotiation",
                    subjectId: detail.negotiationId,
                });
            }
            // Professional was the actor → clinic team is the audience.
            if (detail.actor === "professional") {
                const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
                for (const sub of clinicRecipients) {
                    drafts.push({
                        recipientSub: sub,
                        type,
                        title: `${proName} ${verbToClinic}`,
                        body: detail.shiftDetails?.rate
                            ? (eventType === "negotiation-accepted" ? `Confirmed at $${detail.shiftDetails.rate}/hr` : `Counter rate: $${detail.shiftDetails.rate}/hr`)
                            : undefined,
                        actorName: proName,
                        deepLink: clinicNegotiationDeepLink(detail.negotiationId, detail.applicationId, detail.jobId),
                        subjectType: "negotiation",
                        subjectId: detail.negotiationId,
                    });
                }
            }
            return drafts;
        }

        // -------------------------------------------------------------------
        // Profile views — only the professional has a public profile today.
        // -------------------------------------------------------------------
        case "profile-viewed":
            if (proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "profile_viewed",
                    title: `${clinicName} viewed your profile`,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_PROFILE,
                });
            }
            return drafts;

        // -------------------------------------------------------------------
        // Messages — direction is in `actor`; recipient is the other side.
        // -------------------------------------------------------------------
        case "message-received": {
            const preview = typeof detail.preview === "string" ? detail.preview : undefined;
            if (detail.actor === "clinic" && proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "message_received",
                    title: `New message from ${clinicName}`,
                    body: preview,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_INBOX,
                });
            }
            if (detail.actor === "professional") {
                const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
                for (const sub of clinicRecipients) {
                    drafts.push({
                        recipientSub: sub,
                        type: "message_received",
                        title: `New message from ${proName}`,
                        body: preview,
                        actorName: proName,
                        deepLink: CLINIC_INBOX,
                    });
                }
            }
            // Legacy events without an `actor` field — preserve the original
            // pro-recipient behaviour so older fires don't go dark.
            if (!detail.actor && proSub) {
                drafts.push({
                    recipientSub: proSub,
                    type: "message_received",
                    title: `New message from ${clinicName}`,
                    body: preview,
                    actorName: clinicName,
                    deepLink: PROFESSIONAL_INBOX,
                });
            }
            return drafts;
        }

        default:
            return drafts;
    }

    // `clinicActorSub` and `PROFESSIONAL_DASHBOARD` / `CLINIC_PROFILE` are
    // intentionally retained even though some branches don't use them yet —
    // future events (e.g. clinic profile views by pros) will need them.
    void PROFESSIONAL_DASHBOARD;
    void CLINIC_PROFILE;
}

async function writeOne(draft: NotificationDraft): Promise<void> {
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
    await ddb.send(new PutItemCommand({
        TableName: NOTIFICATIONS_TABLE,
        Item: recordToItem(record),
    }));
}

export const handler = async (
    event: EventBridgeEvent
): Promise<{ statusCode: number; reason?: string; written?: number }> => {
    const detail = event?.detail;
    if (!detail || !detail.eventType) {
        return { statusCode: 200, reason: "no detail" };
    }

    let drafts: NotificationDraft[] = [];
    try {
        drafts = await buildNotifications(detail);
    } catch (err: any) {
        console.error("[event-to-notification] build failed:", err);
        return { statusCode: 500, reason: err?.message || "build failed" };
    }

    if (drafts.length === 0) {
        return { statusCode: 200, reason: `no recipients for ${detail.eventType}` };
    }

    // Best-effort fan-out: a single bad row shouldn't kill the rest. Each
    // failure is logged; the rule retries the whole event so transient
    // failures get a second chance.
    const results = await Promise.allSettled(drafts.map(writeOne));
    const failed = results.filter((r) => r.status === "rejected").length;
    const written = results.length - failed;

    if (failed > 0) {
        console.error("[event-to-notification] some rows failed:", {
            eventType: detail.eventType,
            written,
            failed,
        });
    } else {
        console.log("[event-to-notification] wrote", {
            eventType: detail.eventType,
            written,
        });
    }

    return failed > 0
        ? { statusCode: 500, reason: `${failed}/${drafts.length} rows failed`, written }
        : { statusCode: 200, written };
};
