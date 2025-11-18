"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDB } = require("aws-sdk"); // v2 DocumentClient
const {
  CognitoIdentityProviderClient,
  AdminDeleteUserCommand,
  AdminGetUserCommand,
  ListUsersCommand,
} = require("@aws-sdk/client-cognito-identity-provider");

const dynamodb = new DynamoDB.DocumentClient({ region: process.env.REGION });
const cognito = new CognitoIdentityProviderClient({ region: process.env.REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,DELETE",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Content-Type": "application/json",
};

// ---- helpers ----
function getPathId(event) {
  // Prefer /users/{id} mapping via pathParameters.userId if you defined it
  if (event.pathParameters?.userId) return event.pathParameters.userId;

  // Often you’ll have a greedy proxy: /{proxy+} with proxy = "users/{id}"
  const proxy = event.pathParameters?.proxy || "";
  if (proxy) {
    const parts = proxy.split("/").filter(Boolean);
    // expect ["users", "{id}"]
    if (parts.length >= 2 && parts[0].toLowerCase() === "users") return parts[1];
  }

  // Fallback: try regex on raw path
  const raw = event.path || event.rawPath || "";
  const m = raw.match(/\/users\/([^/]+)(?:\/|$)/i);
  if (m && m[1]) return decodeURIComponent(m[1]);

  return null;
}

function isRootGroup(event) {
  // In your codebase groups may arrive as a string like "Root" or CSV
  const claims = event?.requestContext?.authorizer?.claims || {};
  let raw = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
  if (Array.isArray(raw)) return raw.includes("Root");
  if (typeof raw === "string") {
    if (raw.trim() === "Root") return true;
    // CSV case
    return raw.split(",").map(s => s.trim()).includes("Root");
  }
  return false;
}

// Look up Cognito username if caller sends a sub instead of username/email.
// Returns { username, sub } or null if not found.
async function resolveCognitoUser(idOrSub) {
  // If looks like email (what you used as Username when creating), use directly
  if (idOrSub.includes("@")) {
    // We can optionally AdminGetUser to validate existence, but
    // we'll just return the username so AdminDeleteUser can handle missing user error
    return { username: idOrSub, sub: null };
  }

  // Otherwise treat as sub -> find Username via ListUsers
  const cmd = new ListUsersCommand({
    UserPoolId: process.env.USER_POOL_ID,
    Filter: `sub = "${idOrSub}"`,
    Limit: 1,
  });
  const out = await cognito.send(cmd);
  const user = out?.Users?.[0];
  if (!user) return null;

  const username = user.Username;
  let sub = null;
  for (const attr of user.Attributes || []) {
    if (attr.Name === "sub") {
      sub = attr.Value;
      break;
    }
  }
  return { username, sub };
}

// Remove a userSub from AssociatedUsers in all clinics
// Handles both List and String Set representations.
async function removeUserFromClinics(userSub) {
  // Find all clinics where AssociatedUsers contains this sub
  // Using a Scan with contains() (works on lists; for SS we'll filter client-side if needed).
  const tableName = "DentiPal-Clinics"; // matches your create-user code
  let ExclusiveStartKey;
  const toProcess = [];

  do {
    const page = await dynamodb
      .scan({
        TableName: tableName,
        // FilterExpression will work when AssociatedUsers is a List.
        // If some items store SS, we'll still fetch and filter client-side below.
        FilterExpression: "contains(AssociatedUsers, :sub) OR attribute_exists(AssociatedUsers)",
        ExpressionAttributeValues: { ":sub": userSub },
        ExclusiveStartKey,
      })
      .promise();

    for (const item of page.Items || []) {
      // Decide if item actually contains the sub in either representation
      const au = item.AssociatedUsers;
      let contains = false;
      if (Array.isArray(au)) {
        contains = au.includes(userSub);
      } else if (au && typeof au === "object" && au.wrapperName === "Set") {
        // DynamoDB.DocumentClient set wrapper
        contains = (au.values || []).includes(userSub);
      }
      if (contains) toProcess.push(item);
    }

    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  // Update each clinic to remove the user
  for (const clinic of toProcess) {
    const clinicId = clinic.clinicId;
    if (!clinicId) continue;

    const au = clinic.AssociatedUsers;
    // Case 1: Array(List)
    if (Array.isArray(au)) {
      const newList = au.filter((s) => s !== userSub);
      await dynamodb
        .update({
          TableName: tableName,
          Key: { clinicId },
          UpdateExpression: "SET AssociatedUsers = :list",
          ExpressionAttributeValues: { ":list": newList },
        })
        .promise();
    }
    // Case 2: String Set
    else if (au && typeof au === "object" && au.wrapperName === "Set") {
      // Use a DELETE update on the set
      await dynamodb
        .update({
          TableName: tableName,
          Key: { clinicId },
          UpdateExpression: "DELETE AssociatedUsers :toDel",
          ExpressionAttributeValues: {
            ":toDel": dynamodb.createSet([userSub]),
          },
        })
        .promise();
    }
    // If AssociatedUsers missing or unknown type, nothing to do.
  }
}

const handler = async (event) => {
  try {
    // CORS preflight
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 204, headers: CORS_HEADERS, body: "" };
    }

    // Only Root can delete users
    if (!isRootGroup(event)) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Unauthorized: Only Root users can delete users" }),
      };
    }

    const idOrSub = getPathId(event);
    if (!idOrSub) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "User identifier is required in path (/users/{email-or-sub})" }),
      };
    }

    // Resolve Cognito username (if a sub was provided)
    const resolved = await resolveCognitoUser(idOrSub);
    if (!resolved) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "User not found in Cognito (by sub)" }),
      };
    }

    const username = resolved.username; // Cognito Username (email in your create flow)
    // OPTIONAL: verify existence explicitly (nice error if already gone)
    try {
      await cognito.send(
        new AdminGetUserCommand({
          UserPoolId: process.env.USER_POOL_ID,
          Username: username,
        })
      );
    } catch (e) {
      // If it's not found, return a clean 404
      if (e?.name === "UserNotFoundException") {
        return {
          statusCode: 404,
          headers: CORS_HEADERS,
          body: JSON.stringify({ error: "User does not exist in Cognito" }),
        };
      }
      throw e;
    }

    // Delete from Cognito
    await cognito.send(
      new AdminDeleteUserCommand({
        UserPoolId: process.env.USER_POOL_ID,
        Username: username,
      })
    );

    // Remove from all associated clinics (using sub; if caller passed email, we still need sub)
    const subToRemove = resolved.sub || idOrSub; // if they passed email, we didn't fetch sub; in that case we can't remove from clinics unless you also store email. If your AssociatedUsers stores SUBs (it does), deletion by email requires sub. We already did a ListUsers lookup when idOrSub is not an email. If you want to support email deletes too, you can ListUsers by email similarly and extract sub.
    if (subToRemove && !subToRemove.includes("@")) {
      await removeUserFromClinics(subToRemove);
    } else {
      // If the path id was an email and you want to remove from clinics by sub,
      // do a second lookup by email to fetch 'sub' and then remove.
      try {
        const listByEmail = await cognito.send(
          new ListUsersCommand({
            UserPoolId: process.env.USER_POOL_ID,
            Filter: `email = "${idOrSub}"`,
            Limit: 1,
          })
        );
        const u = listByEmail?.Users?.[0];
        const subAttr = (u?.Attributes || []).find((a) => a.Name === "sub");
        if (subAttr?.Value) {
          await removeUserFromClinics(subAttr.Value);
        }
      } catch {
        // Ignore: clinics cleanup best-effort if deleting by email
      }
    }

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        status: "success",
        message: "User deleted from Cognito and disassociated from clinics",
      }),
    };
  } catch (error) {
    console.error("Error deleting user:", error);
    return {
      statusCode: 400,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error?.message || "Failed to delete user" }),
    };
  }
};

exports.handler = handler;
