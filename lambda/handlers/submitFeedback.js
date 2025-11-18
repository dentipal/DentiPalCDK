"use strict";

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { SESClient, SendEmailCommand } = require("@aws-sdk/client-ses");
const crypto = require("node:crypto");

// Try to load your token validator; handler still works if it's not present
let validateToken;
try { ({ validateToken } = require("./utils")); } catch { /* optional */ }

// ==== ENV ====
const REGION = process.env.REGION || "us-east-1";
const FEEDBACK_TABLE = process.env.FEEDBACK_TABLE || "DentiPal-Feedback";
const SES_FROM = process.env.SES_FROM; // verified email OR address at a verified domain
const SES_TO = process.env.SES_TO;     // comma-separated list, e.g. "support@...,ops@..."

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
const json = (code, body) => ({ statusCode: code, headers: corsHeaders, body: JSON.stringify(body) });
const getMethod = (e) => e?.httpMethod || e?.requestContext?.http?.method || "GET";
const parseBody = (e) => {
  if (!e?.body) return {};
  if (typeof e.body === "string") { try { return JSON.parse(e.body); } catch { return {}; } }
  return e.body || {};
};

function escapeHtml(str = "") {
  return String(str)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}
function escapeHtmlMultiline(str = "") {
  return escapeHtml(str).replaceAll("\n", "<br/>");
}

/** Robustly extract full claims (validateToken, API Gateway authorizer, or decode Bearer payload) */
function extractClaims(event) {
  try {
    if (validateToken) {
      const res = validateToken(event);
      if (res && typeof res === "object") return res; // full claims
      // if it's just a string (sub), fall through to other sources
    }
  } catch {}

  const authz = event?.requestContext?.authorizer;
  if (authz?.jwt?.claims) return authz.jwt.claims;   // HTTP API v2
  if (authz?.claims) return authz.claims;            // REST API v1 (Cognito authorizer)

  const hdr = event?.headers?.authorization || event?.headers?.Authorization;
  if (hdr && /^Bearer\s+/.test(hdr)) {
    try {
      const token = hdr.split(/\s+/)[1];
      const payload = token.split(".")[1];
      const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      return json;
    } catch {}
  }
  return undefined;
}

/** Your rule: Professional iff address.formatted contains "userType:professional"; else Clinic */
function deriveUserTypeFromClaims(claims) {
  if (!claims) return "Clinic";

  // Sometimes Cognito flattens to "address.formatted"
  let formatted = claims["address.formatted"] ? String(claims["address.formatted"]) : "";

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

exports.handler = async (event) => {
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
    const errors = [];
    if (!ft) errors.push("feedbackType is required");
    if (!msg) errors.push("message is required");
    if (msg.length > 5000) errors.push("message too long (max 5000 chars)");
    if (!SES_FROM) errors.push("SES_FROM not configured");
    if (!SES_TO) errors.push("SES_TO not configured");
    if (errors.length) return json(400, { error: "Invalid payload", details: errors });

    // Persist in DynamoDB
    const nowIso = new Date().toISOString();
    const sentAtIST = new Intl.DateTimeFormat("en-IN", {
      timeZone: "Asia/Kolkata", dateStyle: "medium", timeStyle: "long"
    }).format(new Date(nowIso));
    const id = crypto.randomUUID();

    const Item = {
      PK:           { S: "site#feedback" },
      SK:           { S: `feedback#${nowIso}#${id}` },
      FeedbackID:   { S: id },
      FeedbackType: { S: ft },
      Message:      { S: msg },
      ContactMe:    { BOOL: contact },
      CreatedAt:    { S: nowIso },
      // metadata
      UserType:     { S: userType },
      UserSub:      { S: userSub },
      UserEmail:    { S: userEmailFromToken || fallbackEmail },
      UserAgent:    { S: event.headers?.["user-agent"] || event.headers?.["User-Agent"] || "" },
      Referer:      { S: event.headers?.referer || event.headers?.Referer || "" },
      SourceIP:     { S: event.requestContext?.identity?.sourceIp || event.requestContext?.http?.sourceIp || "" }
    };

    await ddb.send(new PutItemCommand({
      TableName: FEEDBACK_TABLE,
      Item,
      ConditionExpression: "attribute_not_exists(FeedbackID)"
    }));

    // Email (3 fields + subject with userType)
    const toAddresses = SES_TO.split(",").map(s => s.trim()).filter(Boolean);
    const subject = `[DentiPal Website Feedback] (${userType}) ${ft}`;

    const htmlBody = `
      <div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5">
        <p><b>User Type:</b> ${escapeHtml(userType)}</p>
        <p><b>Message:</b><br/>${escapeHtmlMultiline(msg)}</p>
        <p><b>Sent At:</b> ${escapeHtml(sentAtIST)} <span style="color:#888">(${escapeHtml(nowIso)})</span></p>
      </div>
    `;
    const textBody =
`User Type: ${userType}
Message:
${msg}

Sent At: ${sentAtIST} (${nowIso})
`;

    const replyTo = [];
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
    const errId = crypto.randomUUID?.() || Date.now().toString();
    console.error("submitWebsiteFeedback error:", errId, err);
    if (err?.name === "ConditionalCheckFailedException") return json(409, { error: "Duplicate feedback ID.", errId });
    if (process.env.DEBUG === "true") {
      const name = (err && (err.name || err.code)) || "Error";
      const msg = (err && err.message) || "Unknown error";
      return json(500, { error: "Internal Server Error", errId, name, message: msg });
    }
    return json(500, { error: "Internal Server Error", errId });
  }
};
