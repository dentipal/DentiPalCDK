/**
 * Job-edit fanout helper.
 *
 * When a clinic edits a posted job (time / pay / role / location), every
 * professional who has applied to it or has an outstanding invitation needs
 * to know — the terms they were considering have shifted under them. We emit
 * one EventBridge event per recipient with `eventType: "job-modified"`; the
 * existing `event-to-notification` consumer turns each into a notification
 * row that the bell + notifications page already render.
 *
 * Used by the type-specific update handlers (updateTemporaryJob,
 * updatePermanentJob, updateMultiDayConsulting). All errors are swallowed —
 * the underlying job edit must not fail just because the fanout did.
 */

import { DynamoDBClient, QueryCommand, GetItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { EventBridgeClient, PutEventsCommand, PutEventsRequestEntry } from "@aws-sdk/client-eventbridge";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const ddb = new DynamoDBClient({ region: REGION });
const eb = new EventBridgeClient({ region: REGION });

const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_INVITATIONS_TABLE = process.env.JOB_INVITATIONS_TABLE!;
const CLINICS_TABLE = process.env.CLINICS_TABLE || "";
const JOB_ID_INDEX = process.env.JOB_ID_INDEX || "jobId-index-1";
// EVENT_BUS_NAME left unset means publish to the default bus, matching the
// pattern used by sendJobInvitations / respondToInvitation / etc. The
// shared ShiftEventRule in the CDK stack listens on the default bus, so
// not setting EventBusName routes the event to event-to-notification.

// Terminal application states — these professionals walked away or were
// processed, so they don't get pinged about further edits.
const SKIP_APPLICATION_STATUSES = new Set([
    "rejected",
    "withdrawn",
    "declined",
    "completed",
    "no_show",
    "cancelled",
]);

// Invitations that the professional already declined, expired, or that the
// clinic withdrew aren't actionable; skip them.
const SKIP_INVITATION_STATUSES = new Set([
    "declined",
    "expired",
    "withdrawn",
    "cancelled",
    "accepted", // accepted invitations transition into applications
]);

export interface JobChangedShiftDetails {
    date?: string;
    role?: string;
    rate?: number;
    startTime?: string;
}

export interface NotifyJobChangedInput {
    jobId: string;
    clinicId?: string;
    clinicName?: string;
    /**
     * Human-readable list of what was edited (e.g. "time, rate, work mode").
     * Surfaced verbatim in the notification body so the recipient knows what
     * changed before opening the dashboard row.
     */
    changedFields: string;
    /** Used to populate the standard "shift line" body when present. */
    shiftDetails?: JobChangedShiftDetails;
}

const queryRecipientsFromTable = async (
    table: string,
    jobId: string,
    statusField: string,
    skipStatuses: Set<string>,
    professionalSubField: string,
): Promise<string[]> => {
    const subs = new Set<string>();
    let lastKey: Record<string, AttributeValue> | undefined;
    do {
        const out = await ddb.send(new QueryCommand({
            TableName: table,
            IndexName: JOB_ID_INDEX,
            KeyConditionExpression: "jobId = :j",
            ExpressionAttributeValues: { ":j": { S: jobId } },
            ExclusiveStartKey: lastKey,
        }));
        for (const item of out.Items || []) {
            const status = item[statusField]?.S?.toLowerCase() || "";
            if (skipStatuses.has(status)) continue;
            const sub = item[professionalSubField]?.S;
            if (sub) subs.add(sub);
        }
        lastKey = out.LastEvaluatedKey;
    } while (lastKey);
    return Array.from(subs);
};

export const notifyJobChanged = async (input: NotifyJobChangedInput): Promise<{ recipients: number }> => {
    const { jobId, clinicId, clinicName, changedFields, shiftDetails } = input;

    if (!jobId) return { recipients: 0 };

    let recipients: string[] = [];
    try {
        const [applicantSubs, inviteeSubs] = await Promise.all([
            queryRecipientsFromTable(
                JOB_APPLICATIONS_TABLE,
                jobId,
                "applicationStatus",
                SKIP_APPLICATION_STATUSES,
                "professionalUserSub",
            ),
            queryRecipientsFromTable(
                JOB_INVITATIONS_TABLE,
                jobId,
                "invitationStatus",
                SKIP_INVITATION_STATUSES,
                "professionalUserSub",
            ),
        ]);
        recipients = Array.from(new Set([...applicantSubs, ...inviteeSubs]));
    } catch (err) {
        console.error("[notifyJobChanged] failed to query recipients (non-fatal):", (err as Error).message);
        return { recipients: 0 };
    }

    if (recipients.length === 0) return { recipients: 0 };

    const entries: PutEventsRequestEntry[] = recipients.map((proSub) => ({
        // EventBusName intentionally omitted — defaults to the "default"
        // bus, which is what ShiftEventRule subscribes to.
        Source: "denti-pal.api",
        DetailType: "ShiftEvent",
        Detail: JSON.stringify({
            eventType: "job-modified",
            jobId,
            clinicId,
            clinicName,
            professionalSub: proSub,
            changedFields,
            shiftDetails,
        }),
    }));

    // EventBridge caps per-call entries at 10.
    for (let i = 0; i < entries.length; i += 10) {
        const batch = entries.slice(i, i + 10);
        try {
            await eb.send(new PutEventsCommand({ Entries: batch }));
        } catch (publishErr) {
            console.error("[notifyJobChanged] failed to publish job-modified batch (non-fatal):", (publishErr as Error).message);
        }
    }

    return { recipients: recipients.length };
};

/**
 * Best-effort clinic name lookup. Used to personalize the notification
 * body ("Acme Dental updated …" vs the generic "Your clinic …" fallback).
 */
const fetchClinicName = async (clinicId: string | undefined): Promise<string | undefined> => {
    if (!clinicId || !CLINICS_TABLE) return undefined;
    try {
        const out = await ddb.send(new GetItemCommand({
            TableName: CLINICS_TABLE,
            Key: { clinicId: { S: clinicId } },
        }));
        return out.Item?.clinic_name?.S || out.Item?.clinicName?.S || undefined;
    } catch (err) {
        console.warn("[notifyJobChanged] clinic name lookup failed (non-fatal):", (err as Error).message);
        return undefined;
    }
};

/**
 * One-stop helper for the type-specific update handlers. Pass the existing
 * job row (raw DDB AttributeValues), the request body, and the jobId — the
 * helper figures out what changed, looks up the clinic name, and fans the
 * job-modified events out to applicants + invitees. Returns 0 recipients
 * when nothing meaningful changed (safe to ignore).
 */
export const notifyJobChangedFromUpdate = async (params: {
    jobId: string;
    existingJob: Record<string, AttributeValue> | undefined;
    updateBody: Record<string, unknown>;
}): Promise<{ recipients: number }> => {
    const { jobId, existingJob, updateBody } = params;
    const changedFields = summarizeChangedFields(updateBody, existingJob);
    if (!changedFields) return { recipients: 0 };

    const clinicId = existingJob?.clinicId?.S;
    const clinicName = await fetchClinicName(clinicId);

    const dateField = existingJob?.date?.S;
    const startTimeField = existingJob?.start_time?.S;
    const roleField = existingJob?.professional_role?.S;
    const rateField = existingJob?.rate?.N ? Number(existingJob.rate.N) : undefined;

    return notifyJobChanged({
        jobId,
        clinicId,
        clinicName,
        changedFields,
        shiftDetails: {
            date: dateField,
            role: roleField,
            rate: rateField,
            startTime: startTimeField,
        },
    });
};

/**
 * Convenience: take the request body's keys and the existing job item, and
 * produce a short comma-separated label for the body of the notification
 * ("time, rate, work mode"). Only labels keys that actually changed value.
 */
export const summarizeChangedFields = (
    updateBody: Record<string, unknown>,
    existingItem: Record<string, AttributeValue> | undefined,
): string => {
    const labels: string[] = [];
    const has = (key: string): boolean => updateBody[key] !== undefined && updateBody[key] !== null;

    // Group changes into user-visible buckets so the message stays short.
    const timeChanged =
        has("date") || has("dates") || has("startTime") || has("start_time") ||
        has("endTime") || has("end_time") || has("hours") || has("hours_per_day") ||
        has("start_date");
    const payChanged =
        has("rate") || has("payType") || has("pay_type") ||
        has("salary_min") || has("salary_max") || has("salaryMin") || has("salaryMax");
    const roleChanged =
        has("professionalRole") || has("professional_role") ||
        has("professionalRoles") || has("professional_roles") ||
        has("shiftSpeciality") || has("shift_speciality");
    const locationChanged = has("workLocationType") || has("work_location_type");
    const requirementsChanged = has("requirements") || has("benefits");

    if (timeChanged) labels.push("time");
    if (payChanged) labels.push("pay");
    if (roleChanged) labels.push("role");
    if (locationChanged) labels.push("work mode");
    if (requirementsChanged) labels.push("requirements");

    // Suppress trivial no-ops: if the request only set fields that already
    // matched the existing item, skip the fanout entirely.
    if (existingItem && labels.length === 0) return "";

    return labels.join(", ");
};
