"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");
const { VALID_ROLE_VALUES, DB_TO_DISPLAY_MAPPING } = require("./professionalRoles");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- CORS headers ---
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // Change to your domain in prod
  "Access-Control-Allow-Headers":
    "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,POST",
  "Content-Type": "application/json",
};

const handler = async (event) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "POST";

  // --- CORS preflight ---
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    // Validate the token to ensure the user is authenticated
    const userSub = await validateToken(event);
    const profileData = JSON.parse(event.body);

    // Validate required fields
    if (!profileData.first_name || !profileData.last_name) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "first_name and last_name are required",
        }),
      };
    }

    // Validate professional role
    if (!VALID_ROLE_VALUES.includes(profileData.role)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Invalid role. Valid options: ${VALID_ROLE_VALUES.map(
            (role) => DB_TO_DISPLAY_MAPPING[role]
          ).join(", ")}`,
        }),
      };
    }

    const timestamp = new Date().toISOString();

    // Build DynamoDB item
    const item = {
      userSub: { S: userSub },
      role: { S: profileData.role },
      first_name: { S: profileData.first_name },
      last_name: { S: profileData.last_name },
      createdAt: { S: timestamp },
      updatedAt: { S: timestamp },
    };

    // Add role-specific fields
    Object.entries(profileData).forEach(([key, value]) => {
      if (
        key !== "role" &&
        key !== "first_name" &&
        key !== "last_name" &&
        value !== undefined
      ) {
        if (typeof value === "string") {
          item[key] = { S: value };
        } else if (typeof value === "boolean") {
          item[key] = { BOOL: value };
        } else if (typeof value === "number") {
          item[key] = { N: value.toString() };
        } else if (Array.isArray(value)) {
          item[key] = { SS: value.length > 0 ? value : [""] };
        }
      }
    });

    // Special handling for specialties
    if (profileData.specialties && Array.isArray(profileData.specialties)) {
      item.specialties = { SS: profileData.specialties };
    }

    // Insert into DynamoDB
    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(userSub)",
      })
    );

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Professional profile created successfully",
        userSub,
        role: profileData.role,
        first_name: profileData.first_name,
        last_name: profileData.last_name,
      }),
    };
  } catch (error) {
    console.error("Error creating professional profile:", error);

    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Professional profile already exists for this user",
        }),
      };
    }

    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.handler = handler;
