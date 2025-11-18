"use strict";
const {
  CognitoIdentityProviderClient,
  ConfirmForgotPasswordCommand,
  ListUsersCommand, // only used if email !== username in your pool
} = require("@aws-sdk/client-cognito-identity-provider");

const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// Helper: resolve Cognito Username from email when your pool does NOT use email-as-username
async function findUsernameByEmail(userPoolId, emailLower) {
  console.log("[confirm] findUsernameByEmail:", emailLower);
  const r = await cognito.send(new ListUsersCommand({
    UserPoolId: userPoolId,
    Filter: `email = "${emailLower}"`,
    Limit: 2,
  }));
  const u = (r.Users || [])[0];
  console.log("[confirm] ListUsers count:", (r.Users || []).length, "picked username:", u?.Username);
  return u?.Username || null;
}

exports.handler = async (event) => {
  console.log("=== /auth/confirm-forgot-password START ===");
  console.log("[req] method:", event?.httpMethod);
  console.log("[req] headers:", JSON.stringify(event?.headers || {}));
  console.log("[req] body:", event?.body);

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS, body: "{}" };
  }

  try {
    const { email, code, newPassword } = JSON.parse(event.body || "{}") || {};
    console.log("[confirm] parsed:", { email, hasCode: !!code, hasPw: !!newPassword });

    if (!email || !code || !newPassword) {
      console.warn("[confirm] missing fields");
      return {
        statusCode: 400,
        headers: CORS,
        body: JSON.stringify({ error: "Required fields: email, code, newPassword" })
      };
    }

    const emailLower = String(email).toLowerCase();
    let username = emailLower;

    // If your pool does NOT use email-as-username, set EMAIL_IS_USERNAME!="true" and provide COGNITO_USER_POOL_ID
    if (process.env.EMAIL_IS_USERNAME !== "true") {
      if (!process.env.USER_POOL_ID) {
        console.error("[confirm] Missing USER_POOL_ID for username lookup");
        return {
          statusCode: 500,
          headers: CORS,
          body: JSON.stringify({ error: "Server misconfiguration (USER_POOL_ID)" })
        };
      }
      username = await findUsernameByEmail(process.env.USER_POOL_ID, emailLower) || emailLower;
    }

    console.log("[confirm] using username:", username);

    const cmd = new ConfirmForgotPasswordCommand({
      ClientId: process.env.CLIENT_ID, // your app client id
      Username: username,
      ConfirmationCode: code,
      Password: newPassword
    });

    await cognito.send(cmd);
    console.log("[confirm] success for:", username);

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({ message: "Password reset successful" })
    };
  } catch (err) {
    console.error("[confirm] ERROR:", err?.name, err?.message);

    // Friendly error mapping
    const name = err?.name || "";
    const message =
      name === "CodeMismatchException" ? "Invalid verification code"
      : name === "ExpiredCodeException" ? "Verification code expired"
      : name === "UserNotFoundException" ? "User not found"
      : name === "InvalidParameterException" ? "Invalid parameters (check password policy)"
      : name === "LimitExceededException" ? "Too many attempts. Try again later."
      : "Password reset failed";

    const status =
      name === "CodeMismatchException" || name === "ExpiredCodeException" || name === "InvalidParameterException"
        ? 400
        : name === "LimitExceededException"
        ? 429
        : name === "UserNotFoundException"
        ? 404
        : 500;

    return {
      statusCode: status,
      headers: CORS,
      body: JSON.stringify({ error: message, details: err?.message })
    };
  }
};
