import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken, UserInfo } from "./utils";
import { corsHeaders } from "./corsHeaders";
import {
    loadPrefs,
    defaultPrefsFor,
    UserType,
    NotificationPreferences,
} from "./notificationPreferences";

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

    try {
        const existing = await loadPrefs(userInfo.sub);
        const record: NotificationPreferences = existing ?? {
            userSub: userInfo.sub,
            userType,
            prefs: defaultPrefsFor(userType),
            unsubscribeAllAt: null,
            updatedAt: new Date().toISOString(),
        };
        return json(event, 200, {
            userSub: record.userSub,
            userType: record.userType,
            prefs: record.prefs,
            unsubscribeAllAt: record.unsubscribeAllAt,
            updatedAt: record.updatedAt,
        });
    } catch (err) {
        console.error("[getNotificationPreferences] load failed", err);
        return json(event, 500, { error: "Failed to load notification preferences" });
    }
};
