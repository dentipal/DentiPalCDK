"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { validateToken, buildAddress } = require("./utils");

const dynamoClient = new DynamoDBClient({ region: process.env.REGION });

/* ----------------- group helpers ----------------- */
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
const normalize = (g) => g.toLowerCase().replace(/[^a-z0-9]/g, ""); // "Clinic Admin" -> "clinicadmin"
const ALLOWED_CREATORS = new Set(["root", "clinicadmin"]);
function canCreateClinic(groups) {
  const normalized = groups.map(normalize);
  const ok = normalized.some(g => ALLOWED_CREATORS.has(g));
  console.log("[auth] groups raw:", groups, "normalized:", normalized, "canCreateClinic:", ok);
  return ok;
}
/* -------------------------------------------------- */

const handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    const userSub = validateToken(event);
    const groups = parseGroupsFromAuthorizer(event);

    if (!canCreateClinic(groups)) {
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: "Only Root or Clinic Admin can create clinics" }),
      };
    }

    const body = JSON.parse(event.body || "{}");
    const { name, addressLine1, addressLine2, addressLine3, city, state, pincode } = body;

    if (!name || !addressLine1 || !city || !state || !pincode) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "Missing required fields: name, addressLine1, city, state, pincode",
        }),
      };
    }

    const address = buildAddress({ addressLine1, addressLine2, addressLine3, city, state, pincode });

    const clinicId = uuidv4();
    const timestamp = new Date().toISOString();

    // Use env to match your existing attribute type:
    //   ASSOCIATED_USERS_TYPE = "SS" (String Set)  or  "L" (List)
    const assocType = (process.env.ASSOCIATED_USERS_TYPE || "L").toUpperCase(); // default L to match your current code

    const AssociatedUsers =
      assocType === "SS"
        ? { SS: [userSub] }
        : { L: [{ S: userSub }] }; // current behavior

    const item = {
      clinicId:     { S: clinicId },
      name:         { S: name },
      addressLine1: { S: addressLine1 },
      addressLine2: { S: addressLine2 || "" },
      addressLine3: { S: addressLine3 || "" },
      city:         { S: (city || "").trim() },
      state:        { S: (state || "").trim() },
      pincode:      { S: (pincode || "").trim() },
      address:      { S: address },
      createdBy:    { S: userSub },
      createdAt:    { S: timestamp },
      updatedAt:    { S: timestamp },
      AssociatedUsers, // <- ensure creator is included on create
    };

    console.log("[create-clinic] PutItem item:", JSON.stringify(item, null, 2));

    await dynamoClient.send(new PutItemCommand({
      TableName: process.env.CLINICS_TABLE, // e.g. "DentiPal-Clinics"
      Item: item,
      ConditionExpression: "attribute_not_exists(clinicId)", // don't overwrite if exists
    }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        status: "success",
        message: "Clinic created successfully",
        clinic: {
          clinicId,
          name,
          addressLine1,
          addressLine2: addressLine2 || "",
          addressLine3: addressLine3 || "",
          city: (city || "").trim(),
          state: (state || "").trim(),
          pincode: (pincode || "").trim(),
          address,
          createdBy: userSub,
          createdAt: timestamp,
          updatedAt: timestamp,
          associatedUsers: [userSub],
        },
      }),
    };
  } catch (error) {
    console.error("Error creating clinic:", error);
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "Failed to create clinic",
        details: error?.message || String(error),
      }),
    };
  }
};

exports.handler = handler;
