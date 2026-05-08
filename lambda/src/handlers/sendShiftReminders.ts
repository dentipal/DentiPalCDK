import {
    DynamoDBClient,
    ScanCommand,
    QueryCommand,
    UpdateItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { computeUtcShiftStart, DEFAULT_TZ } from "./timezone";
import { sendNotificationEmail } from "./sendNotificationEmail";
import { renderTemplate, ShiftContext } from "./notificationTemplates";
import { loadPrefs, isOptedIn, categoryForEvent } from "./notificationPreferences";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE!;
const POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE!;
const POSTINGS_JOB_INDEX = process.env.JOB_ID_INDEX || "jobId-index-1";
const USER_POOL_ID = process.env.USER_POOL_ID!;

const ddb = new DynamoDBClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const HOUR_MS = 60 * 60 * 1000;
const WINDOW_MS = 15 * 60 * 1000;

type ReminderKind = "h24" | "h1";
const REMINDER_OFFSETS: Record<ReminderKind, number> = {
    h24: 24 * HOUR_MS,
    h1: 1 * HOUR_MS,
};
const REMINDER_EVENT: Record<ReminderKind, string> = {
    h24: "shift-reminder-h24",
    h1: "shift-reminder-h1",
};

interface AppRow {
    jobId: string;
    professionalUserSub: string;
    remindersSent: { h24?: boolean; h1?: boolean };
}

interface JobRow {
    jobId: string;
    clinicUserSub: string;
    clinicId?: string;
    date?: string;
    startTime?: string;
    endTime?: string;
    role?: string;
    rate?: number;
    location?: string;
    timezone?: string;
    jobType?: string;
}

function pickAttr(attrs: AttributeType[] | undefined, name: string): string {
    return (attrs || []).find((x) => x.Name === name)?.Value || "";
}

async function scanScheduledApps(): Promise<AppRow[]> {
    const rows: AppRow[] = [];
    let ExclusiveStartKey: Record<string, AttributeValue> | undefined;
    do {
        const out = await ddb.send(new ScanCommand({
            TableName: APPLICATIONS_TABLE,
            FilterExpression: "applicationStatus = :s",
            ExpressionAttributeValues: { ":s": { S: "scheduled" } },
            ExclusiveStartKey,
        }));
        for (const item of out.Items || []) {
            const remindersSent: AppRow["remindersSent"] = {};
            const m = item.remindersSent?.M || {};
            if (m.h24?.BOOL === true) remindersSent.h24 = true;
            if (m.h1?.BOOL === true) remindersSent.h1 = true;
            rows.push({
                jobId: item.jobId?.S || "",
                professionalUserSub: item.professionalUserSub?.S || "",
                remindersSent,
            });
        }
        ExclusiveStartKey = out.LastEvaluatedKey;
    } while (ExclusiveStartKey);
    return rows;
}

async function loadJob(jobId: string): Promise<JobRow | null> {
    const out = await ddb.send(new QueryCommand({
        TableName: POSTINGS_TABLE,
        IndexName: POSTINGS_JOB_INDEX,
        KeyConditionExpression: "jobId = :jid",
        ExpressionAttributeValues: { ":jid": { S: jobId } },
        Limit: 1,
    }));
    const item = (out.Items || [])[0];
    if (!item) return null;
    return {
        jobId,
        clinicUserSub: item.clinicUserSub?.S || "",
        clinicId: item.clinicId?.S,
        date: item.date?.S,
        startTime: item.start_time?.S,
        endTime: item.end_time?.S,
        role: item.professional_role?.S,
        rate: item.rate?.N ? Number(item.rate.N) : undefined,
        location: item.city?.S || item.fullAddress?.S,
        timezone: item.timezone?.S,
        jobType: item.job_type?.S,
    };
}

async function loadProfessional(sub: string): Promise<{ email: string; name: string } | null> {
    try {
        const out = await cognito.send(new AdminGetUserCommand({
            UserPoolId: USER_POOL_ID,
            Username: sub,
        }));
        const email = pickAttr(out.UserAttributes, "email");
        if (!email) return null;
        const given = pickAttr(out.UserAttributes, "given_name");
        const family = pickAttr(out.UserAttributes, "family_name");
        const fullname = pickAttr(out.UserAttributes, "name");
        const name = given?.trim() || fullname?.trim() || [given, family].filter(Boolean).join(" ").trim();
        return { email, name };
    } catch (err) {
        console.error("[sendShiftReminders] cognito lookup failed", { sub, error: (err as Error).message });
        return null;
    }
}

async function claimReminderSlot(app: AppRow, kind: ReminderKind): Promise<boolean> {
    try {
        await ddb.send(new UpdateItemCommand({
            TableName: APPLICATIONS_TABLE,
            Key: {
                jobId: { S: app.jobId },
                professionalUserSub: { S: app.professionalUserSub },
            },
            UpdateExpression: "SET remindersSent = if_not_exists(remindersSent, :empty)",
            ExpressionAttributeValues: { ":empty": { M: {} } },
        }));
        await ddb.send(new UpdateItemCommand({
            TableName: APPLICATIONS_TABLE,
            Key: {
                jobId: { S: app.jobId },
                professionalUserSub: { S: app.professionalUserSub },
            },
            UpdateExpression: "SET remindersSent.#k = :true",
            ConditionExpression: "attribute_not_exists(remindersSent.#k) OR remindersSent.#k = :false",
            ExpressionAttributeNames: { "#k": kind },
            ExpressionAttributeValues: {
                ":true": { BOOL: true },
                ":false": { BOOL: false },
            },
        }));
        return true;
    } catch (err) {
        const name = (err as Error).name;
        if (name === "ConditionalCheckFailedException") return false;
        console.error("[sendShiftReminders] claim failed", { jobId: app.jobId, kind, error: (err as Error).message });
        return false;
    }
}

function shouldFire(now: number, shiftStartMs: number, kind: ReminderKind): boolean {
    const target = shiftStartMs - REMINDER_OFFSETS[kind];
    return Math.abs(now - target) <= WINDOW_MS;
}

async function processApp(app: AppRow, now: number): Promise<void> {
    if (app.remindersSent.h24 && app.remindersSent.h1) return;

    const job = await loadJob(app.jobId);
    if (!job || !job.date || !job.startTime) {
        return;
    }
    if (job.jobType && job.jobType !== "temporary") {
        // v1: reminders only for single-date shifts (temporary). Multi-day / permanent are skipped.
        return;
    }

    const tz = job.timezone || DEFAULT_TZ;
    const shiftStart = computeUtcShiftStart(job.date, job.startTime, tz);
    if (!shiftStart) return;
    const shiftStartMs = shiftStart.getTime();

    for (const kind of ["h24", "h1"] as ReminderKind[]) {
        if (app.remindersSent[kind]) continue;
        if (!shouldFire(now, shiftStartMs, kind)) continue;

        const eventType = REMINDER_EVENT[kind];
        const category = categoryForEvent(eventType);
        if (category) {
            const prefs = await loadPrefs(app.professionalUserSub);
            if (!isOptedIn(prefs, category)) {
                await claimReminderSlot(app, kind); // mark sent to avoid retrying
                continue;
            }
        }

        const claimed = await claimReminderSlot(app, kind);
        if (!claimed) continue;

        const recipient = await loadProfessional(app.professionalUserSub);
        if (!recipient) {
            console.warn("[sendShiftReminders] no recipient email", { sub: app.professionalUserSub });
            continue;
        }

        const ctx: ShiftContext = {
            professionalName: recipient.name || undefined,
            role: job.role,
            date: job.date,
            startTime: job.startTime,
            endTime: job.endTime,
            location: job.location,
            rate: job.rate,
            jobType: job.jobType,
        };
        const rendered = renderTemplate(eventType, ctx);
        if (!rendered) continue;

        await sendNotificationEmail({
            to: recipient.email,
            subject: rendered.subject,
            html: rendered.html,
            text: rendered.text,
        });
    }
}

export const handler = async (): Promise<{ statusCode: number; processed: number }> => {
    const now = Date.now();
    const apps = await scanScheduledApps();
    console.log(`[sendShiftReminders] scanning ${apps.length} scheduled applications`);

    let processed = 0;
    for (const app of apps) {
        try {
            await processApp(app, now);
            processed += 1;
        } catch (err) {
            console.error("[sendShiftReminders] processApp failed", {
                jobId: app.jobId,
                sub: app.professionalUserSub,
                error: (err as Error).message,
            });
        }
    }
    return { statusCode: 200, processed };
};
