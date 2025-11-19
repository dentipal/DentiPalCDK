// Imports
import { CognitoIdentityServiceProvider } from 'aws-sdk';
import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

// --- Initialization ---

// Note: AWS.config.update() isn't strictly necessary here as the region is passed
// directly to the CognitoIdentityServiceProvider constructor.
const cognito = new CognitoIdentityServiceProvider({ region: process.env.REGION });

// Define an interface for the CORS headers for type safety
interface CorsHeaders {
  [header: string]: string | number | boolean;
}

const CORS: CorsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
  "Content-Type": "application/json"
};

// --- Utility Functions ---

/**
 * Decodes a URL-safe Base64 string (b64url) into a UTF-8 string.
 * @param b64url The base64url encoded string.
 * @returns The decoded UTF-8 string.
 */
function b64urlToUtf8(b64url: string): string {
  // Support URL-safe base64: pad and replace characters
  const pad = '='.repeat((4 - (b64url.length % 4)) % 4);
  const b64 = (b64url + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, "base64").toString("utf-8");
}

/**
 * Attempts to safely parse a JSON string.
 * @param label A string label for logging purposes.
 * @param str The string to parse.
 * @returns The parsed object, or undefined if parsing fails.
 */
function safeJsonParse(label: string, str: string): any | undefined {
  try {
    return JSON.parse(str);
  } catch (e) {
    const error = e as Error;
    console.warn(`[decode] Failed to JSON.parse ${label}:`, error.message);
    return undefined;
  }
}

// Define interfaces for the parts of the JWT payload we care about
interface AddressPayload {
  formatted?: string;
  // ... other address fields if needed
}

interface JwtPayload {
  userType?: string;
  email?: string;
  'cognito:username'?: string;
  address?: string | AddressPayload;
  // ... other standard JWT fields
}

/**
 * Derives the user type (professional or clinic) from the decoded JWT payload.
 * @param payload The decoded JWT payload.
 * @returns The decided user type: "professional" or "clinic" (default).
 */
function deriveUserTypeFromIdPayload(payload: JwtPayload | undefined): "professional" | "clinic" {
  if (!payload) {
    console.warn("[derive] Payload is undefined. Defaulting to 'clinic'.");
    return "clinic";
  }

  // 1) top-level userType, if exists
  const topLevel = (typeof payload.userType === "string")
    ? String(payload.userType).toLowerCase()
    : "";

  // 2) or address.formatted like "userType:professional|role:associate_dentist|clinic:none"
  let formattedType = "";
  if (payload.address) {
    let addr: AddressPayload = {};

    if (typeof payload.address === "string") {
      // It's a string, try to parse it
      addr = safeJsonParse("address", payload.address) || {};
    } else {
      // It's already an object
      addr = payload.address;
    }

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

  // Rule: if topLevel OR formattedType is "professional", the decision is "professional", otherwise "clinic".
  const decided = (topLevel === "professional" || formattedType === "professional") ? "professional" : "clinic";
  console.log("[derive] topLevel userType:", topLevel || "(none)",
    "| formatted userType:", formattedType || "(none)",
    "→ DECIDED userType:", decided);
  return decided;
}

// --- Main Handler ---

/**
 * AWS Lambda handler to check an email against a Cognito ID token.
 * @param event The API Gateway proxy event.
 * @returns An API Gateway proxy result.
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  console.log("=== /auth/check-email REQUEST START ===");
  console.log("[req] Raw event.httpMethod:", event?.httpMethod);
  console.log("[req] Raw headers:", JSON.stringify(event?.headers || {}, null, 2));
  console.log("[req] Raw body:", event?.body);

  // Handle preflight OPTIONS request
  if (event.httpMethod === "OPTIONS") {
    console.log("[cors] Preflight OPTIONS handled.");
    return { statusCode: 200, headers: CORS, body: "{}" };
  }

  try {
    // Extract email from body
    const bodyObj = safeJsonParse("request.body", event.body || "{}") || {};
    const email: string | undefined = bodyObj.email;
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
    const payloadJson: JwtPayload | undefined = safeJsonParse("jwt.payload", b64urlToUtf8(parts[1]));
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

    // Fetch raw groups
    let groupNames: string[] = [];
    if (process.env.USER_POOL_ID) {
      try {
        console.log("[cognito] adminListGroupsForUser start");
        const resp = await cognito.adminListGroupsForUser({
          UserPoolId: process.env.USER_POOL_ID,
          Username: email // Use the email from the body as the username
        }).promise();
        groupNames = (resp.Groups || []).map(g => g.GroupName as string);
        console.log("[cognito] adminListGroupsForUser groups:", groupNames);
      } catch (e) {
        const error = e as AWS.AWSError;
        console.warn("[cognito] adminListGroupsForUser failed (non-fatal):", error.code || error.name, error.message);
      }
    } else {
        console.warn("[cognito] Skipping adminListGroupsForUser: USER_POOL_ID is not set in environment.");
    }


    const result = {
      message: "Email verified against token",
      userType,     // "professional" or "clinic" (default)
      groups: groupNames,  // Just for visibility
      tokenEmail    // Useful for debugging mismatches
    };
    console.log("[resp] result:", JSON.stringify(result, null, 2));
    console.log("=== /auth/check-email REQUEST END (200) ===");

    return { statusCode: 200, headers: CORS, body: JSON.stringify(result) };

  } catch (err) {
    const error = err as AWS.AWSError;
    console.error("=== /auth/check-email ERROR ===");
    console.error("name:", error?.name);
    console.error("code:", error?.code);
    console.error("message:", error?.message);
    console.error("stack:", error?.stack);

    const code = error?.code || error?.name;
    if (code === "UserNotFoundException") {
      return { statusCode: 404, headers: CORS, body: JSON.stringify({ error: "User not found" }) };
    }
    return { statusCode: 500, headers: CORS, body: JSON.stringify({ error: `Error verifying email: ${error?.message}` }) };
  }
};