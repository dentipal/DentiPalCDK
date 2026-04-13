import { DynamoDBClient, PutItemCommand, AttributeValue } from "@aws-sdk/client-dynamodb";
import { SESClient, SendEmailCommand } from "@aws-sdk/client-ses";
import * as crypto from "crypto";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
// Import shared CORS headers and utils
import { CORS_HEADERS } from "./corsHeaders";
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
const json = (statusCode: number, bodyObj: object): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
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
      return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }
  
  if (method !== "POST") {
      return json(405, { error: "Use POST" });
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
    if (errors.length) return json(400, { error: "Invalid payload", details: errors });

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

    const feedbackTypeColor = ft.toLowerCase() === "bug" ? "#DC3545"
      : ft.toLowerCase() === "suggestion" ? "#2563eb"
      : "#f59e0b";

    const htmlBody: string = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"/></head>
<body style="margin:0;padding:0;background-color:#fff0f5;font-family:'Segoe UI',Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background-color:#fff0f5;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">

        <!-- Header -->
        <tr><td style="background:linear-gradient(135deg,#f8ccc1 0%,#ffb3a7 100%);padding:32px 40px;text-align:center;">
          <h1 style="margin:0;font-size:28px;color:#532b21;letter-spacing:0.5px;">DentiPal</h1>
          <p style="margin:8px 0 0;color:#7a4a3a;font-size:14px;">Feedback Report</p>
        </td></tr>

        <!-- Badge -->
        <tr><td style="padding:24px 40px 0;text-align:center;">
          <span style="display:inline-block;background:${feedbackTypeColor};color:#fff;padding:6px 20px;border-radius:20px;font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">${escapeHtml(ft)}</span>
        </td></tr>

        <!-- Reporter Info -->
        <tr><td style="padding:24px 40px;">
          <table width="100%" style="background:#fef7f5;border-radius:12px;padding:20px;" cellpadding="0" cellspacing="0">
            <tr><td style="padding:20px;">
              <p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Reported By</p>
              <p style="margin:0 0 16px;font-size:18px;font-weight:700;color:#333;">${escapeHtml(reporterDisplay)}</p>
              <table cellpadding="0" cellspacing="0" style="font-size:14px;color:#555;">
                <tr><td style="padding:4px 16px 4px 0;color:#999;">User Type</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(userType)}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#999;">Email</td><td style="padding:4px 0;font-weight:600;">${escapeHtml(effectiveEmail || "Not provided")}</td></tr>
                <tr><td style="padding:4px 16px 4px 0;color:#999;">Contact</td><td style="padding:4px 0;font-weight:600;">${contact ? "Yes, wants a reply" : "No"}</td></tr>
              </table>
            </td></tr>
          </table>
        </td></tr>

        <!-- Message -->
        <tr><td style="padding:0 40px 24px;">
          <p style="margin:0 0 8px;font-size:13px;color:#999;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Message</p>
          <div style="background:#f9fafb;border-left:4px solid #f8ccc1;padding:16px 20px;border-radius:0 8px 8px 0;font-size:15px;line-height:1.7;color:#333;">
            ${escapeHtmlMultiline(msg)}
          </div>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#fef7f5;padding:20px 40px;border-top:1px solid #fde8e4;">
          <table width="100%" cellpadding="0" cellspacing="0" style="font-size:12px;color:#999;">
            <tr>
              <td>${escapeHtml(sentAtIST)}</td>
              <td style="text-align:right;">ID: ${escapeHtml(userSub || "anonymous")}</td>
            </tr>
          </table>
        </td></tr>

      </table>
      <p style="text-align:center;font-size:12px;color:#ccc;margin-top:16px;">DentiPal - Connecting Dental Professionals</p>
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

    return json(201, {
      message: emailSent ? "Feedback submitted & emailed." : "Feedback submitted (email notification failed).",
      feedbackId: id,
      createdAt: nowIso,
    });
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