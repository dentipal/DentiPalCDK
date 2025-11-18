"use strict";
const { DynamoDB } = require("aws-sdk");
const dynamodb = new DynamoDB.DocumentClient();
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;

const handler = async (event) => {
  console.info("🔧 Starting updateClinicProfile handler");

  try {
    // Step 1: Decode JWT token manually
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      console.error("❌ Missing or invalid Authorization header");
      throw new Error("Missing or invalid Authorization header");
    }

    const token = authHeader.split(" ")[1];
    const payload = token.split(".")[1];
    const decodedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

    const userSub = decodedClaims.sub;
    const groups = decodedClaims["cognito:groups"] || [];
    const userType = decodedClaims["custom:user_type"] || "professional";

    // Step 2: Get clinicId from API Gateway proxy path
    const pathParts = event.path?.split("/") || [];
    const clinicId = pathParts[pathParts.length - 1];

    console.info("📦 Decoded claims:", decodedClaims);
    console.info("🏥 Extracted clinicId from path:", clinicId);

    if (!clinicId || !userSub) {
      console.error("❌ Missing clinicId or userSub");
      return {
        statusCode: 401,
        body: JSON.stringify({ error: "Missing clinicId or userSub" }),
      };
    }

    // Step 3: Verify user is clinic
    if (userType.toLowerCase() !== "clinic" && !groups.includes("clinic") && !groups.includes("Root")) {
      console.warn("🚫 Unauthorized userType for profile update:", userType);
      return {
        statusCode: 403,
        body: JSON.stringify({ error: "Access denied – only clinic users can update clinic profiles" }),
      };
    }

    // Step 4: Parse body and validate
    const requestBody = JSON.parse(event.body || "{}");
    const { profileId, ...updateFields } = requestBody;

    if (!profileId) {
      console.warn("⚠️ profileId missing in request body");
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "profileId is required" }),
      };
    }

    if (Object.keys(updateFields).length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No valid fields provided for update" }),
      };
    }

    // Step 5: Confirm profile exists
    const getParams = {
      TableName: CLINIC_PROFILES_TABLE,
      Key: {
        clinicId,
        userSub
      },
    };

    const existingProfile = await dynamodb.get(getParams).promise();

    if (!existingProfile.Item) {
      console.warn("⚠️ Clinic profile not found for clinicId:", clinicId);
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Clinic profile not found" }),
      };
    }

    // Step 6: Prepare allowed fields
    const allowedFields = [
      "clinic_name", "city", "state", "website", "primary_contact_first_name",
      "primary_contact_last_name", "practice_type", "primary_practice_area",
      "number_of_operatories", "booking_out_period", "free_parking_available",
      "parking_type", "description", "specialties", "business_hours"
    ];

    const validUpdateFields = {};
    const updatedFields = [];

    for (const [key, value] of Object.entries(updateFields)) {
      if (allowedFields.includes(key)) {
        validUpdateFields[key] = value;
        updatedFields.push(key);
      }
    }

    if (updatedFields.length === 0) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "No valid fields provided for update" }),
      };
    }

    // Step 7: Build update expression
    const updateExpression = "SET " +
      updatedFields.map(field => `#${field} = :${field}`).join(", ") +
      ", #updatedAt = :updatedAt";

    const expressionAttributeNames = { "#updatedAt": "updatedAt" };
    const expressionAttributeValues = { ":updatedAt": new Date().toISOString() };

    updatedFields.forEach(field => {
      expressionAttributeNames[`#${field}`] = field;
      expressionAttributeValues[`:${field}`] = validUpdateFields[field];
    });

    const updateParams = {
      TableName: CLINIC_PROFILES_TABLE,
      Key: {
        clinicId,
        userSub
      },
      UpdateExpression: updateExpression,
      ExpressionAttributeNames: expressionAttributeNames,
      ExpressionAttributeValues: expressionAttributeValues,
      ReturnValues: "ALL_NEW",
    };

    const result = await dynamodb.update(updateParams).promise();

    console.info("✅ Clinic profile updated:", result.Attributes);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Clinic profile updated successfully",
        profileId,
        updatedFields,
        updatedAt: new Date().toISOString(),
        profile: result.Attributes,
      }),
    };
  } catch (error) {
    console.error("❌ Error in updateClinicProfile:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: "Failed to update clinic profile" }),
    };
  }
};

exports.handler = handler;
