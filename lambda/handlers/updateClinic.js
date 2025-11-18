"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const client_dynamodb_1 = require("@aws-sdk/client-dynamodb");
const utils_1 = require("./utils");
const dynamoClient = new client_dynamodb_1.DynamoDBClient({ region: process.env.REGION });

/** ----------------- NEW: robust groups parsing + helpers ----------------- */
function parseGroupsFromAuthorizer(event) {
  const claims = event?.requestContext?.authorizer?.claims || {};
  let raw = claims["cognito:groups"] ?? claims["cognito:Groups"] ?? "";
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "string") {
    const val = raw.trim();
    if (!val) return [];
    if (val.startsWith("[") && val.endsWith("]")) {
      try { const arr = JSON.parse(val); return Array.isArray(arr) ? arr : []; } catch {}
    }
    return val.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}
const normalize = (g) => g.toLowerCase().replace(/[^a-z0-9]/g, "");
const ALLOWED_UPDATERS = new Set(["root", "clinicadmin"]);
/** ----------------------------------------------------------------------- */

const handler = async (event) => {
  try {
    // ✅ BUGFIX: validateToken is async in your other handlers
    const userSub = await (0, utils_1.validateToken)(event); // NEW (await)

    // --- NEW: enforce allowed groups (Root, ClinicAdmin) ---
    const rawGroups = parseGroupsFromAuthorizer(event);
    const normalized = rawGroups.map(normalize);
    const isRootGroup = normalized.includes("root");
    const isClinicAdminGroup = normalized.includes("clinicadmin");
    const isAllowedGroup = normalized.some(g => ALLOWED_UPDATERS.has(g));
    if (!isAllowedGroup) {
      return { statusCode: 403, body: JSON.stringify({ error: "Access denied: only Root or ClinicAdmin can update clinics" }) };
    }

    // Check if clinicId is passed as a path parameter or proxy parameter
    let clinicId = event.pathParameters?.clinicId || event.pathParameters?.proxy;
    console.log("Extracted clinicId:", clinicId);

    if (!clinicId) {
      return { statusCode: 400, body: JSON.stringify({ error: "Clinic ID is required in path parameters" }) };
    }

    // Keep your existing access logic:
    // - Root bypasses clinic-scoped check
    // - ClinicAdmin must have clinic access
    if (!isRootGroup) {
      const hasAccess = await (0, utils_1.hasClinicAccess)(userSub, clinicId, "ClinicAdmin");
      if (!hasAccess) {
        return { statusCode: 403, body: JSON.stringify({ error: "Access denied to update clinic" }) };
      }
    }

    const { name, addressLine1, addressLine2, addressLine3, city, state, pincode } = JSON.parse(event.body || '{}');
    const updateExpression = [];
    const expressionAttributeValues = {};
    const expressionAttributeNames = {};

    if (name) {
      updateExpression.push("#name = :name");
      expressionAttributeValues[":name"] = { S: name };
      expressionAttributeNames["#name"] = "name"; // alias for reserved word
    }

    if (addressLine1 || city || state || pincode) {
      const address = (0, utils_1.buildAddress)({ addressLine1: addressLine1 || "", addressLine2, addressLine3, city: city || "", state: state || "", pincode: pincode || "" });
      updateExpression.push("address = :address");
      expressionAttributeValues[":address"] = { S: address };
    }

    updateExpression.push("updatedAt = :updatedAt");
    expressionAttributeValues[":updatedAt"] = { S: new Date().toISOString() };

    if (updateExpression.length === 1) { // only timestamp
      return { statusCode: 400, body: JSON.stringify({ error: "No fields to update" }) };
    }

    const command = new client_dynamodb_1.UpdateItemCommand({
      TableName: process.env.CLINICS_TABLE,
      Key: { clinicId: { S: clinicId } },
      UpdateExpression: `SET ${updateExpression.join(", ")}`,
      ExpressionAttributeValues: expressionAttributeValues,
      ExpressionAttributeNames: expressionAttributeNames,
    });

    await dynamoClient.send(command);
    return {
      statusCode: 200,
      body: JSON.stringify({ status: "success", message: "Clinic updated successfully" }),
    };
  } catch (error) {
    console.error("Error updating clinic:", error);
    return { statusCode: 400, body: JSON.stringify({ error: `Failed to update clinic: ${error.message}` }) };
  }
};

exports.handler = handler;
