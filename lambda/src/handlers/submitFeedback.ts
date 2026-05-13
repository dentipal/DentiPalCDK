import { DynamoDBClient, PutItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import * as crypto from "crypto";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers and utils
import { corsHeaders } from "./corsHeaders";
import { extractUserFromBearerToken } from "./utils";

// --- Type Definitions ---

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

// ==== ENV ====
const REGION: string = process.env.REGION || "us-east-1";
const FEEDBACK_TABLE: string = process.env.FEEDBACK_TABLE || "DentiPal-Feedback";
const SES_FROM: string | undefined = process.env.SES_FROM; // verified email OR address at a verified domain
const SES_TO: string | undefined = process.env.SES_TO; // comma-separated list, e.g. "support@...,ops@..."

const ddb = new DynamoDBClient({ region: REGION });
const ses = new SESClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (event: any, statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
  body: JSON.stringify(bodyObj)
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
  return e.body || {};
};

function escapeHtml(str: string = ""): string {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeHtmlMultiline(str: string = ""): string {
  return escapeHtml(str).replace(/\n/g, "<br/>");
}

async function extractClaims(event: APIGatewayProxyEvent): Promise<Claims | undefined> {
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (authHeader) {
        // If token is valid, this returns decoded claims
        const userInfo = extractUserFromBearerToken(authHeader);
        if (userInfo && userInfo.sub) {
            // Convert UserInfo to Claims shape if necessary, essentially just merging
            // We can try to merge with authorizer claims if present to get email/address
            const authz = event?.requestContext?.authorizer;
            const existingClaims = (authz?.jwt?.claims || authz?.claims) as Claims;
            return { ...existingClaims, sub: userInfo.sub, email: userInfo.email, "cognito:groups": userInfo.groups };
        }
    }
  } catch { 
    // Token might be missing or invalid, but feedback can be anonymous.
    // We proceed to check other sources (authorizer context).
  }

  // 2. Check Request Context (Authorizer)
  const authz = event?.requestContext?.authorizer;
  if (authz?.jwt?.claims) return authz.jwt.claims as Claims;  // HTTP API v2
  if (authz?.claims) return authz.claims as Claims;      // REST API v1 (Cognito authorizer)

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
  const method = getMethod(event);
  
  // CORS Preflight
  if (method === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders(event), body: "" };
  }
  
  if (method !== "POST") {
      return json(event, 405, { error: "Use POST" });
  }

  try {
    // Claims (auth optional)
    const claims = await extractClaims(event);
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
    if (errors.length) return json(event, 400, { error: "Invalid payload", details: errors });

    // Persist in DynamoDB
    const nowIso: string = new Date().toISOString();
    const sentAtIST: string = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "long"
    }).format(new Date(nowIso));
    const id: string = crypto.randomUUID();

    const Item: { [key: string]: AttributeValue } = {
      PK: { S: "site#feedback" },
      SK: { S: `feedback#${nowIso}#${id}` },
      FeedbackID: { S: id },
      FeedbackType: { S: ft },
      Message: { S: msg },
      ContactMe: { BOOL: contact },
      CreatedAt: { S: nowIso },
      // metadata
      UserType: { S: userType },
      UserSub: { S: userSub || "anonymous" }, // ensure S is not empty string
      UserEmail: { S: userEmailFromToken || fallbackEmail || "unknown" }, // ensure S is not empty string
      UserAgent: { S: event.headers?.["user-agent"] || event.headers?.["User-Agent"] || "" },
      Referer: { S: event.headers?.referer || event.headers?.Referer || "" },
      // FIX: Added cast to 'any' for http.sourceIp access
      SourceIP: { S: event.requestContext?.identity?.sourceIp || (event.requestContext as any)?.http?.sourceIp || "" }
    };

    await ddb.send(new PutItemCommand({
      TableName: FEEDBACK_TABLE,
      Item,
      ConditionExpression: "attribute_not_exists(FeedbackID)"
    }));

    // Email
    const toAddresses: string[] = (SES_TO as string).split(",").map(s => s.trim()).filter(Boolean);
    const effectiveEmail = userEmailFromToken || fallbackEmail;
    const reporterDisplay = effectiveEmail || userSub || "Anonymous";

    const subject: string = `[DentiPal Feedback] (${userType}) ${ft} — from ${reporterDisplay}`;

    const ftLower = ft.toLowerCase();
    const badgeBg = ftLower === "bug" ? "#1d1d1f"
      : ftLower === "suggestion" ? "#1d1d1f"
      : "#1d1d1f";
    const badgeAccent = ftLower === "bug" ? "#ff453a"
      : ftLower === "suggestion" ? "#0a84ff"
      : "#ff9f0a";

    const fontStack = "-apple-system,BlinkMacSystemFont,'SF Pro Display','SF Pro Text','Segoe UI',Roboto,Helvetica,Arial,sans-serif";
    const monoStack = "'SF Mono','Menlo','Consolas','Courier New',monospace";
    const year = new Date().getFullYear();

    const metaRow = (label: string, value: string, isLast: boolean = false) => {
      const border = isLast ? "" : "border-bottom:1px solid #e8e8ed;";
      return `<tr>
        <td style="padding:14px 0;color:#6e6e73;font-size:14px;font-weight:400;letter-spacing:-0.01em;${border}">${label}</td>
        <td style="padding:14px 0;color:#1d1d1f;font-size:14px;font-weight:500;letter-spacing:-0.01em;text-align:right;${border}">${value}</td>
      </tr>`;
    };

    const htmlBody: string = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="color-scheme" content="light"/>
<meta name="supported-color-schemes" content="light"/>
<title>DentiPal feedback — ${escapeHtml(ft)}</title>
</head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:${fontStack};-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${escapeHtml(ft)} feedback from ${escapeHtml(reporterDisplay)}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f7;">
    <tr><td align="center" style="padding:48px 16px;">
      <table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

        <tr><td style="padding:0 8px 18px;text-align:center;">
          <span style="display:inline-block;font-size:17px;font-weight:600;color:#1d1d1f;letter-spacing:-0.02em;">DentiPal</span>
          <span style="display:inline-block;font-size:13px;font-weight:500;color:#86868b;letter-spacing:-0.01em;margin-left:8px;">&nbsp;·&nbsp; Internal feedback report</span>
        </td></tr>

        <tr><td style="background:#ffffff;border-radius:22px;box-shadow:0 1px 2px rgba(0,0,0,0.04),0 12px 40px rgba(0,0,0,0.06);overflow:hidden;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
            <tr><td style="padding:40px 40px 28px;">

              <table cellpadding="0" cellspacing="0">
                <tr>
                  <td style="padding:0 10px 0 0;vertical-align:middle;">
                    <span style="display:inline-block;width:8px;height:8px;background:${badgeAccent};border-radius:50%;"></span>
                  </td>
                  <td style="vertical-align:middle;">
                    <span style="display:inline-block;background:${badgeBg};color:#ffffff;padding:5px 12px;border-radius:980px;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;">${escapeHtml(ft)}</span>
                  </td>
                </tr>
              </table>

              <h1 style="margin:18px 0 8px;color:#1d1d1f;font-size:24px;font-weight:700;letter-spacing:-0.025em;line-height:1.2;">New feedback received</h1>
              <p style="margin:0 0 28px;color:#6e6e73;font-size:14px;letter-spacing:-0.005em;">${escapeHtml(sentAtIST)}</p>

              <p style="margin:0 0 12px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Reporter</p>
              <table cellpadding="0" cellspacing="0" width="100%" style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;margin:0 0 24px;">
                <tr><td style="padding:8px 22px 16px;">
                  <p style="margin:14px 0 4px;color:#1d1d1f;font-size:17px;font-weight:600;letter-spacing:-0.015em;">${escapeHtml(reporterDisplay)}</p>
                  <p style="margin:0 0 8px;color:#6e6e73;font-size:13px;letter-spacing:-0.005em;">${escapeHtml(userType)} account</p>
                  <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:8px;">
                    ${metaRow("Email", escapeHtml(effectiveEmail || "Not provided"))}
                    ${metaRow("Wants a reply", contact ? "Yes" : "No", true)}
                  </table>
                </td></tr>
              </table>

              <p style="margin:0 0 12px;color:#86868b;font-size:12px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;">Message</p>
              <div style="background:#ffffff;background-image:linear-gradient(180deg,rgba(255,255,255,0.9) 0%,rgba(245,245,247,0.6) 100%);border:1px solid rgba(0,0,0,0.06);border-radius:16px;padding:20px 24px;margin:0 0 24px;">
                <p style="margin:0;color:#1d1d1f;font-size:15px;line-height:1.65;letter-spacing:-0.005em;white-space:pre-wrap;">${escapeHtmlMultiline(msg)}</p>
              </div>

              <div style="margin:0;padding:16px 20px;background:rgba(245,245,247,0.7);border:1px solid rgba(0,0,0,0.04);border-radius:14px;">
                <table width="100%" cellpadding="0" cellspacing="0">
                  <tr>
                    <td style="color:#86868b;font-size:12px;letter-spacing:-0.005em;">User ID</td>
                    <td style="color:#1d1d1f;font-size:12px;font-family:${monoStack};text-align:right;letter-spacing:0;">${escapeHtml(userSub || "anonymous")}</td>
                  </tr>
                </table>
              </div>

            </td></tr>
          </table>
        </td></tr>

        <tr><td style="padding:24px 24px 8px;text-align:center;">
          <p style="margin:0;color:#86868b;font-size:12px;line-height:1.55;letter-spacing:-0.005em;">
            Internal report. Reply to this email to respond directly to the reporter${contact ? " (they've requested a reply)" : ""}.
          </p>
          <p style="margin:18px 0 0;color:#a1a1a6;font-size:11px;letter-spacing:0.01em;">&copy; ${year} DentiPal</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

    const textBody: string =
      `DentiPal Feedback Report
========================
Type: ${ft}
Reported By: ${reporterDisplay}
User Type: ${userType}
Email: ${effectiveEmail || "Not provided"}
Contact Requested: ${contact ? "Yes" : "No"}

Message:
${msg}

Sent At: ${sentAtIST} (${nowIso})
User ID: ${userSub || "anonymous"}
`;

    const replyTo: string[] = [];
    if (effectiveEmail) replyTo.push(effectiveEmail);

    let emailSent = false;
    try {
      const sesResp = await ses.send(new SendEmailCommand({
        Source: SES_FROM as string,
        Destination: { ToAddresses: toAddresses },
        ReplyToAddresses: replyTo.length ? replyTo : undefined,
        Message: { Subject: { Data: subject }, Body: { Html: { Data: htmlBody }, Text: { Data: textBody } } }
      }));
      emailSent = true;

      if (process.env.DEBUG === "true") {
        console.log("SES MessageId:", sesResp?.MessageId);
      }
    } catch (sesErr) {
      // Email failed but feedback is already saved in DynamoDB — don't return 500
      console.error("SES email failed (feedback still saved):", (sesErr as Error).message);
    }

    return json(event, 201, {
      message: emailSent ? "Feedback submitted & emailed." : "Feedback submitted (email notification failed).",
      feedbackId: id,
      createdAt: nowIso,
    });
  } catch (err) {
    const error = err as Error & { name?: string, code?: string };
    const errId = crypto.randomUUID?.() || Date.now().toString();
    console.error("submitWebsiteFeedback error:", errId, error);

    if (error.name === "ConditionalCheckFailedException") return json(event, 409, { error: "Duplicate feedback ID.", errId });

    if (process.env.DEBUG === "true") {
      const name = (error && (error.name || error.code)) || "Error";
      const msg = (error && error.message) || "Unknown error";
      return json(event, 500, { error: "Internal Server Error", errId, name, message: msg });
    }
    return json(event, 500, { error: "Internal Server Error", errId });
  }
};