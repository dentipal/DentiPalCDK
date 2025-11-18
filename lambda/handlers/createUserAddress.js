"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- CORS headers ---
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*", // or restrict to your domain in prod
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
    const userSub = await validateToken(event);
    const addressData = JSON.parse(event.body);

    if (
      !addressData.addressLine1 ||
      !addressData.city ||
      !addressData.state ||
      !addressData.pincode
    ) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
        error: "Required fields: addressLine1, city, state, pincode",
        }),
      };
    }

    const timestamp = new Date().toISOString();

    // Build DynamoDB item (One-to-One relationship with User)
    const item = {
      userSub: { S: userSub },
      addressLine1: { S: addressData.addressLine1 },
      city: { S: addressData.city },
      state: { S: addressData.state },
      pincode: { S: addressData.pincode },
      country: { S: addressData.country || "USA" },
      addressType: { S: addressData.addressType || "home" },
      isDefault: { BOOL: addressData.isDefault !== false },
      createdAt: { S: timestamp },
      updatedAt: { S: timestamp },
    };

    // Optional fields
    if (addressData.addressLine2) {
      item.addressLine2 = { S: addressData.addressLine2 };
    }
    if (addressData.addressLine3) {
      item.addressLine3 = { S: addressData.addressLine3 };
    }

    await dynamodb.send(
      new PutItemCommand({
        TableName: process.env.USER_ADDRESSES_TABLE,
        Item: item,
        ConditionExpression: "attribute_not_exists(userSub)",
      })
    );

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "User address created successfully",
        userSub,
        addressType: addressData.addressType || "home",
      }),
    };
  } catch (error) {
    console.error("Error creating user address:", error);

    if (error.name === "ConditionalCheckFailedException") {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "User address already exists. Use PUT to update.",
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
