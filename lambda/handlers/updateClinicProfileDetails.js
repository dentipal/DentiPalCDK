"use strict";
const { DynamoDB } = require("aws-sdk");
const dynamodb = new DynamoDB.DocumentClient();
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;

const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Allow-Methods": "OPTIONS,PUT",
};

/**
 * Maps frontend camelCase/nested fields to backend DynamoDB snake_case/flattened attributes.
 * @param {object} body - The raw request body from the frontend.
 * @returns {object} - The transformed and flattened object ready for DynamoDB.
 */
const transformBody = (body) => {
    const transformed = {};
    const mapping = {
        // Direct mapping (camelCase to snake_case)
        clinicName: "clinic_name",
        primaryContactFirstName: "primary_contact_first_name",
        primaryContactLastName: "primary_contact_last_name",
        practiceType: "practice_type",
        primaryPracticeArea: "primary_practice_area",
        parkingType: "parking_type",
        bookingOutPeriod: "booking_out_period",
        softwareUsed: "software_used",
        numberOfOperatories: "number_of_operatories",
        numAssistants: "num_assistants",
        numDoctors: "num_doctors",
        numHygienists: "num_hygienists",
        assistedHygieneAvailable: "assisted_hygiene_available",
        freeParkingAvailable: "free_parking_available",
        insurancePlansAccepted: "insurance_plans_accepted",
        notes: "description", // Frontend 'notes' maps to DynamoDB 'description'
        website: "website",
        dentalAssociation: "dental_association",
        // parkingCost: "parking_cost", // if you add this field to the frontend and DynamoDB, uncomment it

        // Nested/Complex Fields (Flattening)
        location: {
            addressLine1: "address_line_1", // Maps 'Office Address' - assuming it's part of the location
            city: "city",
            state: "state",
            zipCode: "zip_code"
        },
        contactInfo: {
            phone: "clinic_phone", // Maps phone number
            email: "clinic_email", // Maps email
        },
    };

    for (const [key, value] of Object.entries(body)) {
        if (mapping[key] && typeof mapping[key] === 'string') {
            // Direct attribute mapping
            transformed[mapping[key]] = value;
        } else if (mapping[key] && typeof mapping[key] === 'object' && value && typeof value === 'object') {
            // Nested object mapping (e.g., location, contactInfo)
            const nestedMap = mapping[key];
            for (const [nestedKey, nestedValue] of Object.entries(value)) {
                if (nestedMap[nestedKey]) {
                    transformed[nestedMap[nestedKey]] = nestedValue;
                }
            }
        }
        // Exclude unmapped root fields (like profileId/clinicId from the request body as they are handled by path/token)
    }

    return transformed;
};

const handler = async (event) => {
    console.info("🔧 Starting updateClinicProfile handler");
    // console.log("Event:", JSON.stringify(event, null, 2)); // Uncomment for full event logging

    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders, body: "" };
    }

    try {
        // Step 1: Decode JWT token manually
        const authHeader = event.headers?.Authorization || event.headers?.authorization;
        if (!authHeader || !authHeader.startsWith("Bearer ")) {
            throw new Error("Missing or invalid Authorization header");
        }

        const token = authHeader.split(" ")[1];
        const payload = token.split(".")[1];
        const decodedClaims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));

        let userSub = decodedClaims.sub;
        const groups = decodedClaims["cognito:groups"] || [];
        const userType = decodedClaims["custom:user_type"] || "professional";
        
        // console.log("Decoded Claims:", JSON.stringify(decodedClaims, null, 2)); // Uncomment for claims logging
        // console.log("userSub (from token):", userSub);
        // console.log("groups (from token):", groups);
        // console.log("userType (from token):", userType);
        
        if (typeof userSub !== 'string' || userSub.trim().length === 0) {
             console.error("❌ userSub is missing or invalid in token claims.");
             throw new Error("Invalid user identity in token.");
        }

        // Step 2: Get clinicId from API Gateway proxy path
        // Assuming the path format is /clinics/{clinicId}/profile
        const pathParts = event.path?.split("/") || [];
        // Adjust this if your path structure is different.
        // For /clinics/a1b2c3d4/profile, clinicId will be a1b2c3d4
        const clinicIdFromPath = pathParts.filter(Boolean)[pathParts.filter(Boolean).length - 2]; 

        // console.log("clinicId (from path):", clinicIdFromPath);

        if (!clinicIdFromPath) {
            return { 
                statusCode: 400, 
                headers: corsHeaders, 
                body: JSON.stringify({ error: "Missing clinicId in URL path. Ensure the path format is /clinics/{clinicId}/profile" }) 
            };
        }

        // Step 3: Verify user is authorized (Role Check)
        // Only "clinic" users or "Root" (admin) can update clinic profiles.
        // For a regular clinic user, their userSub from the token *must* match the clinicId being updated.
        const isRootUser = groups.includes("Root");
        const isClinicUser = userType.toLowerCase() === "clinic" || groups.includes("clinic");

        // console.log("isRootUser:", isRootUser);
        // console.log("isClinicUser:", isClinicUser);

        if (!isRootUser && (!isClinicUser || userSub !== clinicIdFromPath)) {
            console.warn(`❌ Authorization failed for userSub: ${userSub} trying to update clinicId: ${clinicIdFromPath}. 
                         Root user: ${isRootUser}, Clinic user: ${isClinicUser}, UserSub matches ClinicId: ${userSub === clinicIdFromPath}`);
            return {
                statusCode: 403,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Access denied – you are not authorized to update this clinic profile. Ensure your token's 'sub' claim matches the clinicId in the URL, or you have 'Root' privileges." }),
            };
        }

        // Step 4: No need for explicit bodyClinicId check as the composite key for DynamoDB will handle ownership.
        // We ensure the profile ID for the update is consistent.
        const profileIdForUpdate = clinicIdFromPath; 
        
        // Step 5: Check ownership/existence via DynamoDB Get (using Composite Key)
        // This ensures the profile exists and the current userSub (if not Root) owns it.
        const getParams = {
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: profileIdForUpdate, userSub }, // Composite Key: clinicId is partition key, userSub is sort key
        };

        let existingProfile;
        try {
            existingProfile = await dynamodb.get(getParams).promise();
        } catch (dbError) {
            console.error("❌ DynamoDB get error during ownership check:", dbError);
            return {
                statusCode: 500,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Failed to retrieve clinic profile for validation." }),
            };
        }

        if (!existingProfile.Item) {
            // If the item doesn't exist for this clinicId and userSub combination,
            // it means either the profile doesn't exist, or the userSub doesn't own it.
            // For Root users, they might be trying to update a non-existent profile.
            // For regular clinic users, it means their userSub (clinicId) doesn't match the profile.
            return {
                statusCode: 404,
                headers: corsHeaders,
                body: JSON.stringify({ error: "Clinic profile not found or you do not have permission to access it." }),
            };
        }
        
        // =========================================================================
        // STEP 6: TRANSFORM, MAP, AND FILTER THE INCOMING DATA
        // =========================================================================
        
        const requestBody = JSON.parse(event.body || "{}");
        const dynamoBody = transformBody(requestBody);

        // Define ALL allowed DynamoDB attribute names (snake_case)
        // These fields are based on the table fields you provided.
        const allowedFields = [
            "assisted_hygiene_available",
            "booking_out_period",
            "city",
            "clinic_name",
            "clinic_phone",
            "free_parking_available",
            "insurance_plans_accepted",
            "num_assistants",
            "num_doctors",
            "num_hygienists",
            "number_of_operatories",
            "parking_type",
            "practice_type",
            "primary_contact_first_name",
            "primary_contact_last_name",
            "primary_practice_area",
            "software_used",
            "state",
            "description", // mapped from 'notes'
            "website",
            "dental_association",
            "clinic_email",
            "zip_code",
            "address_line_1",
            // clinicId, userSub, createdAt, updatedAt are managed by the backend and not updated by frontend input
        ];

        const validUpdateFields = {};
        const updatedFields = [];

        // Filter the transformed body to only include allowed DynamoDB fields
        for (const [key, value] of Object.entries(dynamoBody)) {
            // Check if the DynamoDB field is in the allowed list.
            // We allow null, undefined (which gets filtered by update expression anyway)
            // or empty string if the field exists, to allow clearing of fields.
            if (allowedFields.includes(key)) {
                validUpdateFields[key] = value;
                updatedFields.push(key);
            }
        }

        if (updatedFields.length === 0) {
            return {
                statusCode: 400,
                headers: corsHeaders,
                body: JSON.stringify({ error: "No updateable fields provided in the request body after transformation." }),
            };
        }

        // Step 7: Build DynamoDB Update Expression
        let updateExpression = "SET ";
        const expressionAttributeNames = { "#updatedAt": "updatedAt" };
        const expressionAttributeValues = { ":updatedAt": new Date().toISOString() };
        
        const setExpressions = [];

        updatedFields.forEach(field => {
            setExpressions.push(`#${field} = :${field}`);
            expressionAttributeNames[`#${field}`] = field;
            expressionAttributeValues[`:${field}`] = validUpdateFields[field];
        });

        updateExpression += setExpressions.join(", ");

        const updateParams = {
            TableName: CLINIC_PROFILES_TABLE,
            Key: { clinicId: profileIdForUpdate, userSub }, // Composite Key
            UpdateExpression: updateExpression,
            ExpressionAttributeNames: expressionAttributeNames,
            ExpressionAttributeValues: expressionAttributeValues,
            ReturnValues: "ALL_NEW",
        };

        const result = await dynamodb.update(updateParams).promise();

        console.info("✅ Clinic profile updated successfully for clinicId:", profileIdForUpdate);

        // Step 8: Return updated profile data (DynamoDB snake_case attributes)
        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({
                message: "Clinic profile updated successfully",
                clinicId: profileIdForUpdate,
                updatedAt: new Date().toISOString(),
                profile: result.Attributes, 
            }),
        };
    } catch (error) {
        console.error("❌ Unhandled error in updateClinicProfile:", error);
        // Differentiate between known client errors and unexpected server errors
        const statusCode = error.message.includes("Authorization") || error.message.includes("identity") || error.message.includes("Missing clinicId") ? 401 : 500;
        return {
            statusCode: statusCode,
            headers: corsHeaders,
            body: JSON.stringify({ error: error.message || "Failed to update clinic profile due to an unexpected error." }),
        };
    }
};

exports.handler = handler;