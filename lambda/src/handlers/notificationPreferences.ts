import {
    DynamoDBClient,
    GetItemCommand,
    AttributeValue,
} from "@aws-sdk/client-dynamodb";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const PREFS_TABLE = process.env.NOTIFICATION_PREFERENCES_TABLE!;
const ddb = new DynamoDBClient({ region: REGION });

export type UserType = "professional" | "clinic";

export const PROFESSIONAL_CATEGORIES = [
    "shiftNotifications",
    "jobMatches",
    "urgentShifts",
    "marketing",
    "clinicReviews",
    "paymentAlerts",
    "interviewInvites",
    "profileReminders",
    "systemUpdates",
] as const;

export const CLINIC_CATEGORIES: readonly string[] = [];

export type ProfessionalCategory = typeof PROFESSIONAL_CATEGORIES[number];
export type Prefs = Record<string, boolean>;

export interface NotificationPreferences {
    userSub: string;
    userType: UserType;
    prefs: Prefs;
    unsubscribeAllAt: string | null;
    updatedAt: string;
}

export const EVENT_TO_CATEGORY: Record<string, ProfessionalCategory> = {
    "shift-scheduled": "shiftNotifications",
    "shift-cancelled": "shiftNotifications",
    "shift-modified": "shiftNotifications",
    "shift-reminder-h24": "shiftNotifications",
    "shift-reminder-h1": "shiftNotifications",
    "shift-completed": "shiftNotifications",
    "shift-no-show": "shiftNotifications",
    "application-rejected": "jobMatches",
    "invite-sent": "interviewInvites",
};

export function defaultPrefsFor(userType: UserType): Prefs {
    const categories = userType === "professional" ? PROFESSIONAL_CATEGORIES : CLINIC_CATEGORIES;
    const prefs: Prefs = {};
    for (const c of categories) prefs[c] = true;
    return prefs;
}

export function isOptedIn(record: NotificationPreferences | null, category: string): boolean {
    if (!record) return true;
    if (record.unsubscribeAllAt) return false;
    const v = record.prefs?.[category];
    return v === undefined ? true : v === true;
}

export async function loadPrefs(userSub: string): Promise<NotificationPreferences | null> {
    if (!userSub) return null;
    const out = await ddb.send(new GetItemCommand({
        TableName: PREFS_TABLE,
        Key: { userSub: { S: userSub } },
    }));
    if (!out.Item) return null;
    return itemToRecord(out.Item);
}

function itemToRecord(item: Record<string, AttributeValue>): NotificationPreferences {
    const prefsMap = item.prefs?.M || {};
    const prefs: Prefs = {};
    for (const [k, v] of Object.entries(prefsMap)) {
        prefs[k] = v.BOOL === true;
    }
    return {
        userSub: item.userSub?.S || "",
        userType: (item.userType?.S as UserType) || "professional",
        prefs,
        unsubscribeAllAt: item.unsubscribeAllAt?.S || null,
        updatedAt: item.updatedAt?.S || "",
    };
}

export function recordToItem(record: NotificationPreferences): Record<string, AttributeValue> {
    const prefsMap: Record<string, AttributeValue> = {};
    for (const [k, v] of Object.entries(record.prefs)) prefsMap[k] = { BOOL: !!v };
    const item: Record<string, AttributeValue> = {
        userSub: { S: record.userSub },
        userType: { S: record.userType },
        prefs: { M: prefsMap },
        updatedAt: { S: record.updatedAt },
    };
    if (record.unsubscribeAllAt) item.unsubscribeAllAt = { S: record.unsubscribeAllAt };
    return item;
}

export function categoryForEvent(eventType: string): ProfessionalCategory | null {
    return (EVENT_TO_CATEGORY as Record<string, ProfessionalCategory>)[eventType] || null;
}
