"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  CognitoIdentityProviderClient,
  AdminUpdateUserAttributesCommand,
  AdminListGroupsForUserCommand,
  AdminRemoveUserFromGroupCommand,
  AdminAddUserToGroupCommand,
  ListUsersCommand,
  AdminGetUserCommand,
} = require("@aws-sdk/client-cognito-identity-provider");
const { DynamoDB } = require("aws-sdk");

const REGION = process.env.REGION;
const USER_POOL_ID = process.env.USER_POOL_ID;

const cognito = new CognitoIdentityProviderClient({ region: REGION });
const dynamodb = new DynamoDB.DocumentClient();

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "OPTIONS,PUT",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
};

const VALID_SUBGROUPS = ["ClinicAdmin", "ClinicManager", "ClinicViewer"];

// E.164 sanitizer
function toE164(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/[^\d+]/g, "");
  const cleaned = digits.replace(/\++/g, "+").replace(/(?!^)\+/g, "");
  if (!/^\+\d{8,15}$/.test(cleaned)) return null;
  return cleaned;
}

async function getUserSubByUsername(username) {
  try {
    const res = await cognito.send(new AdminGetUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
    }));
    const subAttr = res.UserAttributes?.find(a => a.Name === "sub");
    return subAttr?.Value || null;
  } catch {
    try {
      const res = await cognito.send(new ListUsersCommand({
        UserPoolId: USER_POOL_ID,
        Filter: `email = "${username}"`,
        Limit: 1
      }));
      const user = res.Users?.[0];
      const subAttr = user?.Attributes?.find(a => a.Name === "sub");
      return subAttr?.Value || null;
    } catch {
      return null;
    }
  }
}

async function removeFromClinicSubgroups(username) {
  const res = await cognito.send(new AdminListGroupsForUserCommand({
    UserPoolId: USER_POOL_ID,
    Username: username
  }));
  const current = res.Groups?.map(g => g.GroupName) || [];
  const clinicGroups = current.filter(g => VALID_SUBGROUPS.includes(g));
  for (const g of clinicGroups) {
    await cognito.send(new AdminRemoveUserFromGroupCommand({
      UserPoolId: USER_POOL_ID,
      Username: username,
      GroupName: g
    }));
  }
}

async function upsertUserIntoClinic(clinicId, userSub) {
  const params = {
    TableName: "DentiPal-Clinics",
    Key: { clinicId },
    UpdateExpression: "SET AssociatedUsers = list_append(if_not_exists(AssociatedUsers, :empty), :toAdd)",
    ConditionExpression: "attribute_not_exists(AssociatedUsers) OR NOT contains(AssociatedUsers, :userSub)",
    ExpressionAttributeValues: {
      ":empty": [],
      ":toAdd": [userSub],
      ":userSub": userSub
    },
    ReturnValues: "UPDATED_NEW",
  };
  try {
    await dynamodb.update(params).promise();
  } catch (err) {
    if (err?.code !== "ConditionalCheckFailedException") throw err;
  }
}

function extractUsername(event, bodyEmail) {
  const direct = event.pathParameters?.userId;
  if (direct) return decodeURIComponent(direct);

  const proxy = event.pathParameters?.proxy; // ex: "users/jane@example.com"
  if (proxy && proxy.startsWith("users/")) {
    const rest = proxy.slice(6);
    if (rest) return decodeURIComponent(rest);
  }

  const path = event.path || event.requestContext?.path || "";
  const m = path.match(/\/users\/([^\/\?]+)/i);
  if (m?.[1]) return decodeURIComponent(m[1]);

  if (bodyEmail) return String(bodyEmail); // last resort
  return null;
}

const handler = async (event) => {
  try {
    if (event.httpMethod === "OPTIONS") {
      return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({}) };
    }

    // Auth: Root or ClinicAdmin
    const groupsClaim = event.requestContext?.authorizer?.claims?.['cognito:groups'] || "";
    const groups = Array.isArray(groupsClaim) ? groupsClaim : String(groupsClaim).split(",");
    const isRoot = groups.includes("Root");
    const isClinicAdmin = groups.includes("ClinicAdmin");
    if (!isRoot && !isClinicAdmin) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: "Only Root or ClinicAdmin can update users" }) };
    }

    const body = JSON.parse(event.body || "{}");
    const { firstName, lastName, phoneNumber, subgroup, clinicIds, email } = body;

    const username = extractUsername(event, email);
    if (!username) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Missing username in path. Expected PUT /users/{email}" }) };
    }

    // Ensure user exists
    try {
      await cognito.send(new AdminGetUserCommand({ UserPoolId: USER_POOL_ID, Username: username }));
    } catch {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: `User does not exist: ${username}` }) };
    }

    if (subgroup && !VALID_SUBGROUPS.includes(subgroup)) {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid subgroup" }) };
    }

    const attrs = [];
    if (firstName) attrs.push({ Name: "given_name", Value: firstName });
    if (lastName)  attrs.push({ Name: "family_name", Value: lastName });
    if (phoneNumber) {
      const e164 = toE164(phoneNumber);
      if (!e164) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Invalid phone number format. Use E.164 like +919876543210." }) };
      }
      attrs.push({ Name: "phone_number", Value: e164 });
    }

    if (attrs.length) {
      await cognito.send(new AdminUpdateUserAttributesCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        UserAttributes: attrs
      }));
    }

    if (subgroup) {
      await removeFromClinicSubgroups(username);
      await cognito.send(new AdminAddUserToGroupCommand({
        UserPoolId: USER_POOL_ID,
        Username: username,
        GroupName: subgroup
      }));
    }

    if (Array.isArray(clinicIds) && clinicIds.length > 0) {
      const userSub = await getUserSubByUsername(username);
      if (!userSub) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: "Could not resolve user sub for this username" }) };
      }
      for (const cid of clinicIds) {
        const getRes = await dynamodb.get({ TableName: "DentiPal-Clinics", Key: { clinicId: cid } }).promise();
        if (!getRes.Item) continue;
        await upsertUserIntoClinic(cid, userSub);
      }
    }

    return { statusCode: 200, headers: corsHeaders, body: JSON.stringify({ status: "success", message: "User updated successfully", username }) };
  } catch (error) {
    console.error("Error:", error);
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: error?.message || "Failed to update user" }) };
  }
};

exports.handler = handler;
