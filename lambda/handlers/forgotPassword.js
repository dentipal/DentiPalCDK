"use strict";
const {
  CognitoIdentityProviderClient,
  ListUsersCommand,
  AdminListGroupsForUserCommand,
  ForgotPasswordCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// Configure group mapping via env (no hardcoding in code)
const CLINIC_GROUPS = (process.env.CLINIC_GROUPS || "Root,ClinicAdmin,ClinicManager,ClinicViewer")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
const PRO_GROUPS = (process.env.PRO_GROUPS || "AssociateDentist,DentalHygienist,DentalAssistant,FrontDesk")
  .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

const CLINIC_SET = new Set(CLINIC_GROUPS);
const PRO_SET = new Set(PRO_GROUPS);

// If your pool uses email == username, set EMAIL_IS_USERNAME=true
const EMAIL_IS_USERNAME = process.env.EMAIL_IS_USERNAME === "true";
const USER_POOL_ID = process.env.USER_POOL_ID;
const CLIENT_ID = process.env.CLIENT_ID;

// --- helpers ---
async function findUsernameByEmail(emailLower) {
  if (EMAIL_IS_USERNAME) return emailLower;
  const r = await cognito.send(new ListUsersCommand({
    UserPoolId: USER_POOL_ID,
    Filter: `email = "${emailLower}"`,
    Limit: 2,
  }));
  const u = (r.Users || [])[0];
  return u?.Username || null;
}

async function getGroups(username) {
  const r = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username,
  }));
  return (r.Groups || []).map(g => g.GroupName);
}

function deriveUserTypeFromGroups(groups) {
  const lower = groups.map(g => g.toLowerCase());
  if (lower.some(g => CLINIC_SET.has(g) || g.includes("clinic"))) return "clinic";
  if (lower.some(g => PRO_SET.has(g))) return "professional";
  return "unknown";
}

// --- handler ---
exports.handler = async (event) => {
  console.log("=== /auth/forgot START ===");
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "{}" };
  }

  try {
    const { email, expectedUserType } = JSON.parse(event.body || "{}");
    console.log("[forgot] input:", { email, expectedUserType });

    if (!email) {
      return { statusCode: 400, headers: CORS, body: JSON.stringify({ error: "Email is required" }) };
    }
    if (!CLIENT_ID || !USER_POOL_ID) {
      console.error("[forgot] missing env CLIENT_ID or COGNITO_USER_POOL_ID");
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Server misconfiguration" }) };
    }

    const emailLower = String(email).toLowerCase();

    // 1) Resolve username
    const username = await findUsernameByEmail(emailLower);
    console.log("[forgot] resolved username:", username);
    if (!username) {
      // You can either return generic success (to avoid enumeration) or explicit error.
      // Here, we return generic success:
      return { statusCode: 200, headers: CORS, body: JSON.stringify({ message: "If the email exists, a reset code has been sent." }) };
    }

    // 2) Determine userType from groups
    let groups = [];
    try {
      groups = await getGroups(username);
    } catch (e) {
      console.warn("[forgot] AdminListGroupsForUser failed:", e?.name, e?.message);
      return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: "Role check failed" }) };
    }

    const userType = deriveUserTypeFromGroups(groups);
    console.log("[forgot] groups:", groups, "→ userType:", userType);

    // 3) Enforce side if provided
    if (expectedUserType && userType !== "unknown" && userType !== expectedUserType) {
      // This is the behavior you asked for:
      // e.g., user is clinic but tried to reset on professional side
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({
          error: `This account is a ${userType} account. Please use the ${userType === "clinic" ? "Clinic" : "Professional"} portal.`
        })
      };
    }

    // 4) Send the code
    await cognito.send(new ForgotPasswordCommand({
      ClientId: CLIENT_ID,
      Username: username, // use resolved username
    }));

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ message: "If the email exists, a reset code has been sent." })
    };
  } catch (err) {
    console.error("[forgot] ERROR:", err?.name, err?.message);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: "An error occurred while initiating the password reset. Please try again." })
    };
  }
};
