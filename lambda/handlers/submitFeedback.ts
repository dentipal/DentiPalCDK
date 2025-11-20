import { DynamoDBClient, PutItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import * as crypto from "node:crypto";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";

// --- Type Definitions ---

/** Interface for the result of a token validation (full claims object) */
interface ValidateTokenResult {
    sub?: string;
    email?: string;
    "cognito:username"?: string;
    [key: string]: any; // Allow other claim properties
}

/** Claims object extracted from token or authorizer */
interface Claims extends ValidateTokenResult {
    "address.formatted"?: string;
    address?: string | { formatted?: string } | any; // Could be a stringified object, an object, or just a string
}

/** Interface for the expected request body */
interface FeedbackBody {
    feedbackType?: string;
    message?: string;
    contactMe?: boolean;
    email?: string;
}

// Try to load your token validator; handler still works if it's not present
let validateToken: ((event: APIGatewayProxyEvent) => ValidateTokenResult | string | undefined) | undefined;
try {
    // Note: You must ensure './utils' exports validateToken, and define the module in tsconfig.json if needed.
    ({ validateToken } = require("./utils"));
} catch {
    /* optional */
}

// ==== ENV ====
const REGION: string = process.env.REGION || "us-east-1";
const FEEDBACK_TABLE: string = process.env.FEEDBACK_TABLE || "DentiPal-Feedback";
const SES_FROM: string | undefined = process.env.SES_FROM; // verified email OR address at a verified domain
const SES_TO: string | undefined = process.env.SES_TO; // comma-separated list, e.g. "support@...,ops@..."

const ddb = new DynamoDBClient({ region: REGION });
const ses = new SESClient({ region: REGION });

// ---- CORS / helpers ----
const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
        "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "OPTIONS,POST",
    "Content-Type": "application/json"
};

const json = (code: number, body: any): APIGatewayProxyResult => ({
    statusCode: code,
    headers: corsHeaders,
    body: JSON.stringify(body)
});

const getMethod = (e: APIGatewayProxyEvent): string =>
    // FIX: Cast requestContext to 'any' to access 'http' (HTTP API v2 property) safely
    e?.httpMethod || (e?.requestContext as any)?.http?.method || "GET";

const parseBody = (e: APIGatewayProxyEvent): FeedbackBody => {
    if (!e?.body) return {};
    if (typeof e.body === "string") {
        try {
            return JSON.parse(e.body) as FeedbackBody;
        } catch {
            return {};
        }
    }
    // Should not happen in typical API Gateway setup, but for robustness
    return e.body || {};
};

function escapeHtml(str: string = ""): string {
    // FIX: Replaced .replaceAll with .replace(/.../g) for compatibility with older TS targets
    return String(str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function escapeHtmlMultiline(str: string = ""): string {
    // FIX: Replaced .replaceAll with .replace(/.../g)
    return escapeHtml(str).replace(/\n/g, "<br/>");
}

/** Robustly extract full claims (validateToken, API Gateway authorizer, or decode Bearer payload) */
function extractClaims(event: APIGatewayProxyEvent): Claims | undefined {
    try {
        if (validateToken) {
            const res = validateToken(event);
            if (res && typeof res === "object") return res as Claims; // full claims
            // if it's just a string (sub), fall through to other sources
        }
    } catch { /* optional */ }

    const authz = event?.requestContext?.authorizer;
    if (authz?.jwt?.claims) return authz.jwt.claims as Claims;  // HTTP API v2
    if (authz?.claims) return authz.claims as Claims;      // REST API v1 (Cognito authorizer)

    const hdr = event?.headers?.authorization || event?.headers?.Authorization;
    if (hdr && /^Bearer\s+/.test(hdr)) {
        try {
            const token = hdr.split(/\s+/)[1];
            // Decode base64url payload
            const payload = token.split(".")[1];
            if (payload) {
                // Ensure padding is correct for base64url to base64 conversion for Buffer
                const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
                const json = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
                return json as Claims;
            }
        } catch { /* optional */ }
    }
    return undefined;
}

/** Your rule: Professional iff address.formatted contains "userType:professional"; else Clinic */
function deriveUserTypeFromClaims(claims: Claims | undefined): "Professional" | "Clinic" {
    if (!claims) return "Clinic";

    // Sometimes Cognito flattens to "address.formatted"
    let formatted: string = claims["address.formatted"] ? String(claims["address.formatted"]) : "";

    // Or it's under "address" (object or string)
    if (!formatted) {
        const addr = claims.address;
        if (typeof addr === "string") {
            try {
                const obj = JSON.parse(addr);
                formatted = String(obj?.formatted ?? addr);
            } catch {
                formatted = addr; // plain pipe-string: "userType:professional|role:...|clinic:none"
            }
        } else if (addr && typeof addr === "object") {
            formatted = String(addr.formatted ?? "");
        }
    }

    return /userType\s*:\s*professional/i.test(formatted) ? "Professional" : "Clinic";
}

// The main handler function
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    try {
        const method = getMethod(event);
        if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders, body: "" };
        if (method !== "POST") return json(405, { error: "Use POST" });

        // Claims (auth optional)
        const claims = extractClaims(event);
        const userSub = typeof claims === "string"
            ? claims
            : (claims?.sub || claims?.["cognito:username"] || claims?.userSub || "");
        
        const userEmailFromToken =
            (typeof claims === "object" && (claims.email || claims["custom:email"])) || "";

        const userType = deriveUserTypeFromClaims(claims); // <-- Professional or Clinic per your rule

        if (process.env.DEBUG === "true") {
            const sample =
                claims?.["address.formatted"] ??
                (typeof claims?.address === "string" ? claims.address :
                    (claims?.address?.formatted ?? ""));
            console.log("address.formatted sample:", sample);
            console.log("derived userType:", userType);
        }

        // Body
        const { feedbackType, message, contactMe, email } = parseBody(event);
        const ft = String(feedbackType ?? "").trim();
        const msg = String(message ?? "").trim();
        const contact = !!contactMe;
        const fallbackEmail = String(email ?? "").trim(); // optional for visitors

        // Validate
        const errors: string[] = [];
        if (!ft) errors.push("feedbackType is required");
        if (!msg) errors.push("message is required");
        if (msg.length > 5000) errors.push("message too long (max 5000 chars)");
        if (!SES_FROM) errors.push("SES_FROM not configured");
        if (!SES_TO) errors.push("SES_TO not configured");
        if (errors.length) return json(400, { error: "Invalid payload", details: errors });

        // Persist in DynamoDB
        const nowIso: string = new Date().toISOString();
        const sentAtIST: string = new Intl.DateTimeFormat("en-IN", {
            timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "long"
        }).format(new Date(nowIso));
        const id: string = crypto.randomUUID();

        const Item: { [key: string]: AttributeValue } = {
            PK:      { S: "site#feedback" },
            SK:      { S: `feedback#${nowIso}#${id}` },
            FeedbackID:  { S: id },
            FeedbackType: { S: ft },
            Message:   { S: msg },
            ContactMe:  { BOOL: contact },
            CreatedAt:  { S: nowIso },
            // metadata
            UserType:   { S: userType },
            UserSub:    { S: userSub || "anonymous" }, // ensure S is not empty string
            UserEmail:  { S: userEmailFromToken || fallbackEmail || "unknown" }, // ensure S is not empty string
            UserAgent:  { S: event.headers?.["user-agent"] || event.headers?.["User-Agent"] || "" },
            Referer:    { S: event.headers?.referer || event.headers?.Referer || "" },
            // FIX: Added cast to 'any' for http.sourceIp access
            SourceIP:   { S: event.requestContext?.identity?.sourceIp || (event.requestContext as any)?.http?.sourceIp || "" }
        };

        await ddb.send(new PutItemCommand({
            TableName: FEEDBACK_TABLE,
            Item,
            ConditionExpression: "attribute_not_exists(FeedbackID)"
        }));

        // Email (3 fields + subject with userType)
        const toAddresses: string[] = (SES_TO as string).split(",").map(s => s.trim()).filter(Boolean);
        const subject: string = `[DentiPal Website Feedback] (${userType}) ${ft}`;

        const htmlBody: string = `
            <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">
                <p><b>User Type:</b> ${escapeHtml(userType)}</p>
                <p><b>Message:</b><br/>${escapeHtmlMultiline(msg)}</p>
                <p><b>Sent At:</b> ${escapeHtml(sentAtIST)} <span style="color:#888">(${escapeHtml(nowIso)})</span></p>
            </div>
        `;
        const textBody: string =
`User Type: ${userType}
Message:
${msg}

Sent At: ${sentAtIST} (${nowIso})
`;

        const replyTo: string[] = [];
        const effectiveEmail = userEmailFromToken || fallbackEmail;
        if (contact && effectiveEmail) replyTo.push(effectiveEmail);

        const sesResp = await ses.send(new SendEmailCommand({
            Source: SES_FROM,
            Destination: { ToAddresses: toAddresses },
            ReplyToAddresses: replyTo.length ? replyTo : undefined,
            Message: { Subject: { Data: subject }, Body: { Html: { Data: htmlBody }, Text: { Data: textBody } } }
        }));

        if (process.env.DEBUG === "true") {
            console.log("SES MessageId:", sesResp?.MessageId);
        }

        return json(201, { message: "Feedback submitted & emailed.", feedbackId: id, createdAt: nowIso });
    } catch (err) {
        const error = err as Error & { name?: string, code?: string };
        const errId = crypto.randomUUID?.() || Date.now().toString();
        console.error("submitWebsiteFeedback error:", errId, error);

        if (error.name === "ConditionalCheckFailedException") return json(409, { error: "Duplicate feedback ID.", errId });
        
        if (process.env.DEBUG === "true") {
            const name = (error && (error.name || error.code)) || "Error";
            const msg = (error && error.message) || "Unknown error";
            return json(500, { error: "Internal Server Error", errId, name, message: msg });
        }
        return json(500, { error: "Internal Server Error", errId });
    }
};