import {
    CognitoIdentityProviderClient,
    AdminGetUserCommand,
    AttributeType,
} from "@aws-sdk/client-cognito-identity-provider";
import { sendNotificationEmail } from "./sendNotificationEmail";
import { renderTemplate, ShiftContext } from "./notificationTemplates";
import {
    loadPrefs,
    isOptedIn,
    categoryForEvent,
} from "./notificationPreferences";

const REGION = process.env.AWS_REGION || process.env.REGION || "us-east-1";
const USER_POOL_ID = process.env.USER_POOL_ID!;
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const PROFESSIONAL_EVENTS = new Set([
    "shift-scheduled",
    "shift-cancelled",
    "shift-modified",
    "shift-completed",
    "shift-no-show",
    "application-rejected",
    "invite-sent",
    "shift-reminder-h24",
    "shift-reminder-h1",
]);

interface EventDetail {
    eventType: string;
    clinicId?: string;
    professionalSub?: string;
    shiftDetails?: ShiftContext;
}

interface EventBridgeEvent {
    detail: EventDetail;
}

function pickAttr(attrs: AttributeType[] | undefined, name: string): string {
    return (attrs || []).find((x) => x.Name === name)?.Value || "";
}

async function getProfessional(sub: string): Promise<{ email: string; name: string } | null> {
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
        const name = given?.trim() || fullname?.trim() || [given, family].filter(Boolean).join(" ").trim() || "";
        return { email, name };
    } catch (err) {
        console.error("[event-to-email] cognito lookup failed", { sub, error: (err as Error).message });
        return null;
    }
}

export const handler = async (event: EventBridgeEvent): Promise<{ statusCode: number }> => {
    const { detail } = event;
    if (!detail || !detail.eventType) {
        console.warn("[event-to-email] event has no detail.eventType", JSON.stringify(event));
        return { statusCode: 200 };
    }

    if (!PROFESSIONAL_EVENTS.has(detail.eventType)) {
        console.log("[event-to-email] skipping non-professional event", detail.eventType);
        return { statusCode: 200 };
    }

    const professionalSub = detail.professionalSub;
    if (!professionalSub) {
        console.warn("[event-to-email] missing professionalSub", JSON.stringify(detail));
        return { statusCode: 200 };
    }

    const category = categoryForEvent(detail.eventType);
    if (category) {
        const prefs = await loadPrefs(professionalSub);
        if (!isOptedIn(prefs, category)) {
            console.log("[event-to-email] recipient opted out", { professionalSub, category });
            return { statusCode: 200 };
        }
    }

    const recipient = await getProfessional(professionalSub);
    if (!recipient) {
        console.warn("[event-to-email] could not resolve recipient email", { professionalSub });
        return { statusCode: 200 };
    }

    const ctx: ShiftContext = {
        ...(detail.shiftDetails || {}),
        professionalName: recipient.name || undefined,
    };

    const rendered = renderTemplate(detail.eventType, ctx);
    if (!rendered) {
        console.warn("[event-to-email] no template for event", detail.eventType);
        return { statusCode: 200 };
    }

    await sendNotificationEmail({
        to: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
    });

    return { statusCode: 200 };
};
