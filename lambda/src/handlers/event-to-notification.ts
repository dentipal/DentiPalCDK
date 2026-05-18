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
    /** Stored on the row so the frontend can construct clinic-scoped URLs
     *  (JobApplicantsPage requires `?clinicId=` to initialize). */
    clinicId?: string;
    /** Stored on the row so the frontend can navigate to
     *  `/jobs/${jobId}/applicants` for negotiation rows (whose subjectId
     *  is the negotiationId, not the jobId). */
    jobId?: string;
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

/** Build a clinic-dashboard URL pointing at a specific tab. The dashboard
 *  reads `view` from search params on mount and switches to that tab; it
 *  also reads `jobId` so the right row inside the tab can be focused. This
 *  keeps every "clinic needs to act" notification on the dashboard the user
 *  already knows — no separate applicants page, no overview hop, no
 *  "Initializing Clinic..." spinner. */
function clinicDashboardDeepLink(
    view: "actionNeeded" | "invites" | "scheduled" | "completed" | "open",
    opts: { clinicId?: string; jobId?: string } = {}
): string {
    const params = new URLSearchParams();
    params.set("view", view);
    if (opts.clinicId) params.set("clinicId", opts.clinicId);
    if (opts.jobId) params.set("jobId", opts.jobId);
    return `${CLINIC_DASHBOARD}?${params.toString()}`;
}

/** Job-scoped events (shifts, no-show, job edits) land on the Action Needed
 *  tab scoped to the relevant job. */
function clinicJobDeepLink(jobId: string | undefined, clinicId: string | undefined): string {
    return clinicDashboardDeepLink("actionNeeded", { clinicId, jobId });
}

/** Negotiation events land on the JobApplicantsPage for the job, with the
 *  negotiating applicant's card auto-scrolled-to + highlighted via the
 *  `negotiationId` query param. JobApplicantsPage stamps each card with
 *  `data-negotiation-id` so the matching one is locatable. We fall back to
 *  the dashboard's Action Needed tab when we don't know the job (older
 *  events). */
function clinicNegotiationDeepLink(
    negotiationId: string | undefined,
    _applicationId: string | undefined,
    jobId: string | undefined,
    clinicId: string | undefined
): string {
    if (!jobId) return clinicDashboardDeepLink("actionNeeded", { clinicId, jobId });
    const params = new URLSearchParams();
    if (clinicId) params.set("clinicId", clinicId);
    if (negotiationId) params.set("negotiationId", negotiationId);
    const qs = params.toString();
    return qs
        ? `/jobs/${encodeURIComponent(jobId)}/applicants?${qs}`
        : `/jobs/${encodeURIComponent(jobId)}/applicants`;
}

// `CLINIC_NEGOTIATIONS` and `CLINIC_INBOX` are kept for the message-received
// case below (CLINIC_INBOX) and for any future event that wants the overview.
void CLINIC_NEGOTIATIONS;

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
                    deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                    clinicId: detail.clinicId,
                    jobId: detail.jobId,
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
                    deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                    clinicId: detail.clinicId,
                    jobId: detail.jobId,
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
                        deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                        subjectType: "job",
                        subjectId: detail.jobId,
                        clinicId: detail.clinicId,
                        jobId: detail.jobId,
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
                        deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                        actorName: proName,
                        subjectType: "job",
                        subjectId: detail.jobId,
                        clinicId: detail.clinicId,
                        jobId: detail.jobId,
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
                    deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                    clinicId: detail.clinicId,
                    jobId: detail.jobId,
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

        case "application-withdrawn": {
            // Pro withdrew their application → tell the clinic team so they
            // don't keep that candidate in their decision pipeline. The pro
            // is the actor; no row written back to them.
            const clinicRecipients = await clinicRecipientsExcludingActor(detail.clinicId, undefined);
            for (const sub of clinicRecipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "application_withdrawn",
                    title: `${proName} withdrew their application`,
                    body: shiftLine || undefined,
                    actorName: proName,
                    deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                    subjectType: "application",
                    subjectId: detail.applicationId,
                    clinicId: detail.clinicId,
                    jobId: detail.jobId,
                });
            }
            return drafts;
        }

        case "job-deleted": {
            // Clinic removed a job posting → tell every pro who had skin in
            // the game (active application OR pending invite). The handler
            // that deleted the job passes the recipient sub lists in the
            // event detail so this consumer doesn't re-query the DB.
            const applicantSubs: string[] = Array.isArray(detail.applicantSubs)
                ? detail.applicantSubs.filter((s: unknown): s is string => typeof s === "string")
                : [];
            const inviteeSubs: string[] = Array.isArray(detail.inviteeSubs)
                ? detail.inviteeSubs.filter((s: unknown): s is string => typeof s === "string")
                : [];
            // De-dupe — a pro could be both an applicant and an invitee.
            const recipients = Array.from(new Set([...applicantSubs, ...inviteeSubs]));
            for (const sub of recipients) {
                drafts.push({
                    recipientSub: sub,
                    type: "job_deleted",
                    title: `${clinicName} cancelled a job posting`,
                    body: shiftLine || undefined,
                    actorName: clinicName,
                    // Job is gone — there's no detail page to deep-link to.
                    // Pending tab is the natural landing spot (the row will
                    // disappear from there once the pro's app cache refreshes).
                    deepLink: PROFESSIONAL_DASHBOARD_PENDING,
                    subjectType: "job",
                    subjectId: detail.jobId,
                });
            }
            return drafts;
        }

        case "profile-updated": {
            // Pro updated a material field on their profile (rate / role /
            // license / name). The emitter passes the list of clinicIds with
            // an active relationship to the pro (active applications + open
            // invites); we fan each clinicId out to its team here.
            const clinicIds: string[] = Array.isArray(detail.clinicIds)
                ? detail.clinicIds.filter((s: unknown): s is string => typeof s === "string")
                : [];
            const changedFields: string[] = Array.isArray(detail.changedFields)
                ? detail.changedFields.filter((s: unknown): s is string => typeof s === "string")
                : [];
            const summary = changedFields.length > 0
                ? `Updated: ${changedFields.join(", ")}`
                : undefined;
            const seenSubs = new Set<string>();
            for (const cid of clinicIds) {
                // Pro is the actor — no clinic-side actor to exclude.
                const teamSubs = await clinicRecipientsExcludingActor(cid, undefined);
                for (const sub of teamSubs) {
                    if (seenSubs.has(sub)) continue; // multi-clinic dedupe
                    seenSubs.add(sub);
                    drafts.push({
                        recipientSub: sub,
                        type: "profile_updated",
                        title: `${proName} updated their profile`,
                        body: summary,
                        actorName: proName,
                        // No clinic-side detail view for a pro's profile; land
                        // on the dashboard so the user can locate the pro via
                        // their existing relationships (apps / invites).
                        deepLink: CLINIC_DASHBOARD,
                        subjectType: "professional",
                        subjectId: proSub,
                        clinicId: cid,
                    });
                }
            }
            return drafts;
        }

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
                    deepLink: clinicJobDeepLink(detail.jobId, detail.clinicId),
                    subjectType: "job",
                    subjectId: detail.jobId,
                    clinicId: detail.clinicId,
                    jobId: detail.jobId,
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
                        deepLink: clinicNegotiationDeepLink(detail.negotiationId, detail.applicationId, detail.jobId, detail.clinicId),
                        subjectType: "negotiation",
                        subjectId: detail.negotiationId,
                        clinicId: detail.clinicId,
                        jobId: detail.jobId,
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
                        clinicId: detail.clinicId,
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
        clinicId: draft.clinicId,
        jobId: draft.jobId,
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
