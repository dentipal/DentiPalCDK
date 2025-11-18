"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils"); // Import validateToken function

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// Environment Variables
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;
const CLINIC_JOBS_POSTED_TABLE = process.env.CLINIC_JOBS_POSTED_TABLE;
const CLINICS_JOBS_COMPLETED_TABLE = process.env.CLINICS_JOBS_COMPLETED_TABLE;

// Common CORS headers
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST",
};

const handler = async (event) => {
  try {
    // Handle preflight (OPTIONS)
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({}),
      };
    }

    // Step 1: Validate the JWT token
    const decodedToken = await validateToken(event);
    console.log("Decoded Token:", decodedToken);

    if (!decodedToken) {
      return {
        statusCode: 401,
        headers: corsHeaders,
        body: JSON.stringify({ error: "Unauthorized - Invalid token" }),
      };
    }

    const userSub = decodedToken;
    console.log("Extracted userSub:", userSub);

    // Step 2: Fetch clinic profiles
    const queryParams = {
      TableName: CLINIC_PROFILES_TABLE,
      IndexName: "userSub-index",
      KeyConditionExpression: "userSub = :userSub",
      ExpressionAttributeValues: {
        ":userSub": { S: userSub },
      },
    };
    const result = await dynamodb.send(new QueryCommand(queryParams));

    if (!result.Items || result.Items.length === 0) {
      return {
        statusCode: 404,
        headers: corsHeaders,
        body: JSON.stringify({ error: "No clinic profiles found" }),
      };
    }

    // Unmarshal the main clinic profiles (full version)
    const clinicProfiles = result.Items.map((clinic) => ({
      clinicId: clinic.clinicId?.S || "",
      userSub: clinic.userSub?.S || "",
      clinicName: clinic.clinic_name?.S || "",
      clinicType: clinic.clinic_type?.S || "",
      practiceType: clinic.practice_type?.S || "",
      primaryPracticeArea: clinic.primary_practice_area?.S || "",
      primaryContactFirstName: clinic.primary_contact_first_name?.S || "",
      primaryContactLastName: clinic.primary_contact_last_name?.S || "",
      assistedHygieneAvailable: clinic.assisted_hygiene_available?.BOOL || false,
      numberOfOperatories: clinic.number_of_operatories?.N
        ? parseInt(clinic.number_of_operatories.N)
        : 0,
      numHygienists: clinic.num_hygienists?.N
        ? parseInt(clinic.num_hygienists.N)
        : 0,
      numAssistants: clinic.num_assistants?.N
        ? parseInt(clinic.num_assistants.N)
        : 0,
      numDoctors: clinic.num_doctors?.N ? parseInt(clinic.num_doctors.N) : 0,
      bookingOutPeriod: clinic.booking_out_period?.S || "immediate",
      clinic_software: clinic.clinic_software?.S || "",
      software_used: clinic.software_used?.S || "",
      parkingType: clinic.parking_type?.S || "",
      freeParkingAvailable: clinic.free_parking_available?.BOOL || false,
      createdAt: clinic.createdAt?.S || "",
      updatedAt: clinic.updatedAt?.S || "",
      location: {
        addressLine1: clinic.addressLine1?.S || "",
        addressLine2: clinic.addressLine2?.S || "",
        addressLine3: clinic.addressLine3?.S || "",
        city: clinic.city?.S || "",
        state: clinic.state?.S || "",
        zipCode: clinic.zipCode?.S || "",
      },
      contactInfo: {
        email: clinic.contact_email?.S || "",
        phone: clinic.contact_phone?.S || "",
      },
      specialRequirements: clinic.special_requirements?.SS || [],
    }));

    // -----------------------------------------------------------------
    // STEP 3: Enrich each profile with job stats
    // -----------------------------------------------------------------
    const enrichedProfiles = await Promise.all(
      clinicProfiles.map(async (clinic) => {
        // --- Get Posted Jobs Count ---
        const postedParams = {
          TableName: CLINIC_JOBS_POSTED_TABLE,
          IndexName: "ClinicIdIndex", // ⚠️ Check this GSI name
          KeyConditionExpression: "clinicId = :clinicId",
          ExpressionAttributeValues: {
            ":clinicId": { S: clinic.clinicId },
          },
          Select: "COUNT",
        };
        const postedResult = await dynamodb.send(new QueryCommand(postedParams));
        const jobsPosted = postedResult.Count || 0;

        // --- Get Completed Jobs Count & Total Paid ---
        const completedParams = {
          TableName: CLINICS_JOBS_COMPLETED_TABLE,
          IndexName: "clinicId-index", // ⚠️ Check this GSI name
          KeyConditionExpression: "clinicId = :clinicId",
          ExpressionAttributeValues: {
            ":clinicId": { S: clinic.clinicId },
          },
        };
        const completedResult = await dynamodb.send(
          new QueryCommand(completedParams)
        );

        const jobsCompleted = completedResult.Items
          ? completedResult.Items.length
          : 0;
          
        // ⚠️ FIXED: Using 'acceptedRate' from your schema
        const totalPaid = completedResult.Items
          ? completedResult.Items.reduce((acc, item) => {
              // ⚠️ ASSUMPTION: 'acceptedRate' is a Number (N)
              const amount = parseFloat(item.acceptedRate?.N || "0");
              return acc + amount;
            }, 0)
          : 0;

        // Return the original clinic data + the new stats
        return {
          ...clinic,
          jobsPosted: jobsPosted,
          jobsCompleted: jobsCompleted,
          totalPaid: totalPaid,
        };
      })
    );

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: "Clinic profiles retrieved successfully",
        profiles: enrichedProfiles,
      }),
    };
  } catch (error) {
    // ******* THIS IS THE LINE YOU NEED *******
    // It will print the real AWS error to your CloudWatch logs
    console.error("DETAILED ERROR:", error); 
    // *****************************************

    console.error("Error retrieving clinic profiles:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: "Failed to retrieve clinic profiles" }),
    };
  }
};

exports.handler = handler;