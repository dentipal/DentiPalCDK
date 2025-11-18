"use strict";
const { DynamoDB } = require("aws-sdk");
const dynamodb = new DynamoDB.DocumentClient();
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;

const handler = async (event) => {
  console.info("🗑️ Starting deleteClinicAccountHandler");

  try {
    // Step 1: Decode JWT token manually
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("❌ Missing or invalid Authorization header");
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Missing or invalid Authorization header" }),
      };
    }

    const token = authHeader.split(" ")[1];
    const payload = token.split(".")[1];
    const decodedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    const userSub = decodedClaims.sub;
    const groups = (decodedClaims["cognito:groups"] || []).map((g) => g.toLowerCase());
    const userType = (decodedClaims["custom:user_type"] || "professional").toLowerCase();

    console.info("📦 Decoded claims:", decodedClaims);

    if (!userSub) {
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Missing userSub in token" }),
      };
    }

    if (userType !== "clinic" && !groups.includes("clinic") && !groups.includes("root")) {
      return {
        statusCode: 403,
        body: JSON.stringify({
          error: "Access denied – only clinic users can delete their account",
        }),
      };
    }

    // Step 2: Extract clinicId from URL path
    const pathParts = event.path?.split("/") || [];
    const clinicId = pathParts[pathParts.length - 1];

    if (!clinicId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Missing clinicId in path" }),
      };
    }

    console.info("📌 Deleting clinicId:", clinicId, "| userSub:", userSub);

    // Step 3: Check existence
    const getParams = {
      TableName: CLINIC_PROFILES_TABLE,
      Key: { clinicId, userSub },
    };

    const existing = await dynamodb.get(getParams).promise();

    if (!existing.Item) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Clinic profile not found" }),
      };
    }

    // Step 4: Delete profile
    const deleteParams = {
      TableName: CLINIC_PROFILES_TABLE,
      Key: { clinicId, userSub },
    };

    await dynamodb.delete(deleteParams).promise();
    console.info(`✅ Clinic account deleted for clinicId: ${clinicId}, userSub: ${userSub}`);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Clinic account deleted successfully",
        clinicId,
        deletedAt: new Date().toISOString(),
      }),
    };
  } catch (error) {
    console.error("🔥 Error deleting clinic account:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to delete clinic account" }),
    };
  }
};

exports.handler = handler;
