import {
    DynamoDBClient,
    PutItemCommand,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, UserInfo } from "./utils";
import { corsHeaders } from "./corsHeaders";
import {
    loadPrefs,
    defaultPrefsFor,
    recordToItem,
    PROFESSIONAL_CATEGORIES,
    UserType,
    Prefs,
    NotificationPreferences,
} from "./notificationPreferences";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const PREFS_TABLE = process.env.NOTIFICATION_PREFERENCES_TABLE!;
const ddb = new DynamoDBClient({ region: REGION });

function deriveUserType(userInfo: UserInfo): UserType {
    if (userInfo.userType === "clinic") return "clinic";
    return "professional";
}

function json(event: APIGatewayProxyEvent, statusCode: number, body: object): APIGatewayProxyResult {
    return {
        statusCode,
        headers: corsHeaders(event),
        body: JSON.stringify(body),
    };
}

interface UpdateBody {
    prefs?: Record<string, unknown>;
    unsubscribeAll?: boolean;
}

function validateProfessionalPrefs(input: Record<string, unknown>): Prefs | { error: string } {
    const allowed = new Set<string>(PROFESSIONAL_CATEGORIES);
    const out: Prefs = {};
    for (const [k, v] of Object.entries(input)) {
        if (!allowed.has(k)) return { error: `Unknown category: ${k}` };
        if (typeof v !== "boolean") return { error: `Category ${k} must be boolean` };
        out[k] = v;
    }
    return out;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }

    let userInfo: UserInfo;
    try {
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        userInfo = extractUserFromBearerToken(authHeader);
    } catch (err) {
        return json(event, 401, { error: "Unauthorized", message: (err as Error).message });
    }

    const userType = deriveUserType(userInfo);
    if (userType !== "professional") {
        return json(event, 400, { error: "Clinic notification preferences are not supported in v1" });
    }

    let body: UpdateBody;
    try {
        body = event.body ? JSON.parse(event.body) : {};
    } catch {
        return json(event, 400, { error: "Invalid JSON body" });
    }

    if (!body || typeof body !== "object") {
        return json(event, 400, { error: "Body must be a JSON object" });
    }

    const existing = await loadPrefs(userInfo.sub);
    const basePrefs = existing?.prefs ?? defaultPrefsFor(userType);
    let nextPrefs: Prefs = { ...basePrefs };

    if (body.prefs !== undefined) {
        if (typeof body.prefs !== "object" || body.prefs === null) {
            return json(event, 400, { error: "prefs must be an object" });
        }
        const validated = validateProfessionalPrefs(body.prefs);
        if ("error" in validated) {
            return json(event, 400, { error: validated.error });
        }
        nextPrefs = { ...nextPrefs, ...validated };
    }

    let unsubscribeAllAt: string | null = existing?.unsubscribeAllAt ?? null;
    if (body.unsubscribeAll === true) unsubscribeAllAt = new Date().toISOString();
    else if (body.unsubscribeAll === false) unsubscribeAllAt = null;

    const record: NotificationPreferences = {
        userSub: userInfo.sub,
        userType,
        prefs: nextPrefs,
        unsubscribeAllAt,
        updatedAt: new Date().toISOString(),
    };

    try {
        await ddb.send(new PutItemCommand({
            TableName: PREFS_TABLE,
            Item: recordToItem(record),
        }));
    } catch (err) {
        console.error("[updateNotificationPreferences] put failed", err);
        return json(event, 500, { error: "Failed to save notification preferences" });
    }

    return json(event, 200, {
        userSub: record.userSub,
        userType: record.userType,
        prefs: record.prefs,
        unsubscribeAllAt: record.unsubscribeAllAt,
        updatedAt: record.updatedAt,
    });
};
