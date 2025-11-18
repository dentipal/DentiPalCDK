"use strict";

const AWS = require("aws-sdk");
const cognito = new AWS.CognitoIdentityServiceProvider({ region: process.env.REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

function b64urlToUtf8(b64url) {
  // Support URL-safe base64
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, "base64").toString("utf-8");
}

function safeJsonParse(label, str) {
  try {
    return JSON.parse(str);
  } catch (e) {
    console.warn(`[decode] Failed to JSON.parse ${label}:`, e?.message);
    return undefined;
  }
}

function deriveUserTypeFromIdPayload(payload) {
  // 1) top-level userType, if exists
  const topLevel = (payload && typeof payload.userType === "string")
    ? String(payload.userType).toLowerCase()
    : "";

  // 2) or address.formatted like "userType:professional|role:associate_dentist|clinic:none"
  let formattedType = "";
  if (payload && payload.address) {
    const addr = typeof payload.address === "string"
      ? safeJsonParse("address", payload.address) || {}
      : payload.address;

    const formatted = addr?.formatted;
    if (typeof formatted === "string") {
      const m = /userType\s*:\s*([a-zA-Z_]+)/.exec(formatted);
      if (m && m[1]) {
        formattedType = String(m[1]).toLowerCase();
      }
      console.log("[derive] address.formatted:", formatted, "→ parsed userType:", formattedType || "(none)");
    } else {
      console.log("[derive] address.formatted not found or not a string.");
    }
  }

  const decided = (topLevel || formattedType) === "professional" ? "professional" : "clinic";
  console.log("[derive] topLevel userType:", topLevel || "(none)",
              "| formatted userType:", formattedType || "(none)",
              "→ DECIDED userType:", decided);
  return decided;
}

exports.handler = async (event) => {
  console.log("=== /auth/check-email REQUEST START ===");
  console.log("[req] Raw event.httpMethod:", event?.httpMethod);
  console.log("[req] Raw headers:", JSON.stringify(event?.headers || {}, null, 2));
  console.log("[req] Raw body:", event?.body);

  if (event.httpMethod === "OPTIONS") {
    console.log("[cors] Preflight OPTIONS handled.");
    return { statusCode: 200, headers: CORS, body: "{}" };
  }

  try {
    // Extract email from body
    const { email } = JSON.parse(event.body || "{}");
    console.log("[body] email:", email);

    if (!email) {
      console.warn("[validate] Missing email in body.");
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Email is required" }) };
    }

    // Extract id token from Authorization header
    const authHeader = event.headers?.authorization || event.headers?.Authorization || "";
    console.log("[auth] Authorization header:", authHeader ? "(present)" : "(missing)");

    if (!authHeader.startsWith("Bearer ")) {
      console.warn("[auth] Missing or invalid Bearer token.");
      return {
        statusCode: 401,
        headers: CORS,
        body: JSON.stringify({ error: "Authorization Bearer ID token is required" })
      };
    }

    const idToken = authHeader.slice("Bearer ".length).trim();
    const parts = idToken.split(".");
    if (parts.length !== 3) {
      console.warn("[decode] ID token does not have 3 JWT parts.");
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Invalid ID token format" }) };
    }

    // Decode JWT payload
    const headerJson = safeJsonParse("jwt.header", b64urlToUtf8(parts[0]));
    const payloadJson = safeJsonParse("jwt.payload", b64urlToUtf8(parts[1]));
    console.log("[decode] JWT header:", JSON.stringify(headerJson || {}, null, 2));
    console.log("[decode] JWT payload keys:", payloadJson ? Object.keys(payloadJson) : "(none)");

    // Optional: sanity-check email matches the token's email (if present)
    const tokenEmail = payloadJson?.email || payloadJson?.["cognito:username"];
    console.log("[decode] token email/cognito:username:", tokenEmail || "(absent)");
    if (tokenEmail && String(tokenEmail).toLowerCase() !== String(email).toLowerCase()) {
      console.warn("[validate] Body email and token email mismatch.",
                   "body:", email, "token:", tokenEmail);
      // Not fatal: we continue, but you can decide to reject here.
    }

    // Decide userType with the rule: if NOT 'professional' → 'clinic'
    const userType = deriveUserTypeFromIdPayload(payloadJson);

    // (Optional) Fetch raw groups for visibility ONLY; they do not affect userType.
    // This requires that your pool uses email as username; otherwise switch to the actual username.
    let groupNames = [];
    try {
      console.log("[cognito] adminListGroupsForUser start");
      const resp = await cognito.adminListGroupsForUser({
        UserPoolId: process.env.USER_POOL_ID,
        Username: email
      }).promise();
      groupNames = (resp.Groups || []).map(g => g.GroupName);
      console.log("[cognito] adminListGroupsForUser groups:", groupNames);
    } catch (e) {
      console.warn("[cognito] adminListGroupsForUser failed (non-fatal):", e?.code || e?.name, e?.message);
    }

    const result = {
      message: "Email verified against token",
      userType,     // "professional" or "clinic" (default)
      groups: groupNames,  // Just for visibility
      tokenEmail    // Useful for debugging mismatches
    };
    console.log("[resp] result:", JSON.stringify(result, null, 2));
    console.log("=== /auth/check-email REQUEST END (200) ===");

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch (err) {
    console.error("=== /auth/check-email ERROR ===");
    console.error("name:", err?.name);
    console.error("code:", err?.code);
    console.error("message:", err?.message);
    console.error("stack:", err?.stack);

    const code = err?.code || err?.name;
    if (code === "UserNotFoundException") {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "User not found" }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Error verifying email: ${err?.message}` }) };
  }
};
                