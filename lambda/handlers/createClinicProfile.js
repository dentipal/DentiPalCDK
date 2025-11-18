"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// CORS headers
const corsHeaders = {
    "Access-Control-Allow-Origin": "*", // You can specify your frontend origin, e.g., 'http://localhost:5173'
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-API-Key", // Adjust headers as per your needs
};

const handler = async (event) => {
    try {
        const userSub = await validateToken(event);
        const profileData = JSON.parse(event.body);

        // Required fields check (no city/state — already in Clinics table)
        if (
            !profileData.clinicId ||
            !profileData.practice_type ||
            !profileData.primary_practice_area ||
            !profileData.primary_contact_first_name ||
            !profileData.primary_contact_last_name
        ) {
            return {
                statusCode: 400,
                headers: corsHeaders,  // Include CORS headers here
                body: JSON.stringify({
                    error: "Required fields: clinicId, practice_type, primary_practice_area, primary_contact_first_name, primary_contact_last_name"
                })
            };
        }

        const timestamp = new Date().toISOString();

        // 🔍 Step 1: Check if the clinic exists and user is authorized
        const getClinic = await dynamodb.send(new GetItemCommand({
            TableName: process.env.CLINICS_TABLE,
            Key: { clinicId: { S: profileData.clinicId } }
        }));

        if (!getClinic.Item) {
            return {
                statusCode: 404,
                headers: corsHeaders,  // Include CORS headers here
                body: JSON.stringify({ error: "Clinic not found with provided clinicId" })
            };
        }

        const associatedUsers = getClinic.Item.AssociatedUsers?.L?.map(u => u.S) || [];
        if (!associatedUsers.includes(userSub)) {
            return {
                statusCode: 403,
                headers: corsHeaders,  // Include CORS headers here
                body: JSON.stringify({ error: "User is not authorized to create a profile for this clinic" })
            };
        }

        // ✅ Step 2: Build the item with composite key (clinicId + userSub)
        const item = {
            clinicId: { S: profileData.clinicId },
            userSub: { S: userSub },
            practice_type: { S: profileData.practice_type },
            primary_practice_area: { S: profileData.primary_practice_area },
            primary_contact_first_name: { S: profileData.primary_contact_first_name },
            primary_contact_last_name: { S: profileData.primary_contact_last_name },
            assisted_hygiene_available: { BOOL: profileData.assisted_hygiene_available || false },
            number_of_operatories: { N: (profileData.number_of_operatories || 0).toString() },
            num_hygienists: { N: (profileData.num_hygienists || 0).toString() },
            num_assistants: { N: (profileData.num_assistants || 0).toString() },
            num_doctors: { N: (profileData.num_doctors || 0).toString() },
            booking_out_period: { S: profileData.booking_out_period || "immediate" },
            free_parking_available: { BOOL: profileData.free_parking_available || false },
            createdAt: { S: timestamp },
            updatedAt: { S: timestamp }
        };

        // ✅ Step 3: Add optional dynamic fields
        Object.entries(profileData).forEach(([key, value]) => {
            if (!item[key] && value !== undefined) {
                if (typeof value === "string") item[key] = { S: value };
                else if (typeof value === "boolean") item[key] = { BOOL: value };
                else if (typeof value === "number") item[key] = { N: value.toString() };
                else if (Array.isArray(value)) item[key] = { SS: value.length ? value : [""] };
            }
        });

        // ✅ Step 4: Save to DentiPal-Clinic-Profiles
        await dynamodb.send(new PutItemCommand({
            TableName: process.env.CLINIC_PROFILES_TABLE, // This should be set to "DentiPal-Clinic-Profiles" in env
            Item: item,
            ConditionExpression: "attribute_not_exists(clinicId) AND attribute_not_exists(userSub)"
        }));

        return {
            statusCode: 201,
            headers: corsHeaders,  // Include CORS headers here
            body: JSON.stringify({
                message: "Clinic profile created successfully",
                clinicId: profileData.clinicId
            })
        };

    } catch (error) {
        console.error("Error creating clinic profile:", error);

        if (error.name === "ConditionalCheckFailedException") {
            return {
                statusCode: 409,
                headers: corsHeaders,  // Include CORS headers here
                body: JSON.stringify({
                    error: "A profile already exists for this clinic and user"
                })
            };
        }

        return {
            statusCode: 500,
            headers: corsHeaders,  // Include CORS headers here
            body: JSON.stringify({ error: error.message })
        };
    }
};

exports.handler = handler;
