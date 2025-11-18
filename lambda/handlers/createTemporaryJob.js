"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./utils");
const { VALID_ROLE_VALUES } = require("./professionalRoles");
const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// --- CORS ---
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
  "Content-Type": "application/json",
};

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
const normalizeGroup = (g) => g.toLowerCase().replace(/[^a-z0-9]/g, ""); // "Clinic Manager" -> "clinicmanager"
const ALLOWED_GROUPS = new Set(["root", "clinicadmin", "clinicmanager"]);
/* ------------------------------------------------- */

// read one clinic profile row by composite key
async function getClinicProfileByUser(clinicId, userSub) {
  const res = await dynamodb.send(
    new GetItemCommand({
      TableName: process.env.CLINIC_PROFILES_TABLE,
      Key: { clinicId: { S: clinicId }, userSub: { S: userSub } },
    })
  );
  return res.Item || null;
}

const handler = async (event) => {
  // Preflight
  const method = event?.httpMethod || event?.requestContext?.http?.method;
  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    const userSub = await validateToken(event); // This should be a clinic user

    // ---- Group authorization (Root, ClinicAdmin, ClinicManager only) ----
    const rawGroups = parseGroupsFromAuthorizer(event);
    const normalized = rawGroups.map(normalizeGroup);
    const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Access denied: only Root, ClinicAdmin, or ClinicManager can create jobs" }),
      };
    }
    // --------------------------------------------------------------------

    const jobData = JSON.parse(event.body);

    // Validate required fields
    if (
      !jobData.clinicIds ||
      !Array.isArray(jobData.clinicIds) ||
      jobData.clinicIds.length === 0 ||
      !jobData.professional_role ||
      !jobData.date ||
      !jobData.shift_speciality ||
      !jobData.hours ||
      !jobData.hourly_rate ||
      !jobData.start_time ||
      !jobData.end_time
    ) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error:
            "Required fields: clinicIds (array), professional_role, date, shift_speciality, hours, hourly_rate, start_time, end_time",
        }),
      };
    }

    // Validate professional role using the imported validation
    if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(", ")}`,
        }),
      };
    }

    // Validate date format
    const jobDate = new Date(jobData.date);
    if (isNaN(jobDate.getTime())) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invalid date format. Use ISO date string." }),
      };
    }

    // Validate date is today or in the future
    const today = new Date();
    today.setHours(0, 0, 0, 0); // Set to midnight, so time is ignored
    if (jobDate < today) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Job date must be today or in the future" }),
      };
    }

    // Validate hours and rate
    if (jobData.hours < 1 || jobData.hours > 12) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Hours must be between 1 and 12" }),
      };
    }
    if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Hourly rate must be between $10 and $200" }),
      };
    }

    const timestamp = new Date().toISOString();
    const jobIds = []; // To store the generated jobIds for all clinics

    // Loop through each clinicId and post the job
    const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
      const jobId = uuidv4(); // Generate unique job ID for each clinic
      jobIds.push(jobId); // Collect jobId for response

      // Fetch clinic address details (+ owner)
      const clinicCommand = new GetItemCommand({
        TableName: process.env.CLINICS_TABLE,
        Key: {
          clinicId: { S: clinicId },
        },
      });

      const clinicResponse = await dynamodb.send(clinicCommand);
      if (!clinicResponse.Item) {
        throw new Error(`Clinic not found: ${clinicId}`);
      }

      const clinic = clinicResponse.Item;
      const clinicAddress = {
        addressLine1: clinic.addressLine1?.S || "",
        addressLine2: clinic.addressLine2?.S || "",
        addressLine3: clinic.addressLine3?.S || "",
        fullAddress:
          clinic.address?.S ||
          `${clinic.addressLine1?.S || ""} ${clinic.addressLine2?.S || ""} ${clinic.addressLine3?.S || ""}`.replace(/\s+/g, " ").trim(),
        city: clinic.city?.S || "",
        state: clinic.state?.S || "",
        pincode: clinic.pincode?.S || "",
      };
      const clinicOwnerSub = clinic.createdBy?.S;

      // Fetch profile details from the Clinic Profiles Table (fallbacks + defaults)
      let profileItem = await getClinicProfileByUser(clinicId, userSub);
      if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
        try { profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub); } catch {}
      }

      const p = profileItem || {};
      const profileData = {
        bookingOutPeriod: p.booking_out_period?.S || p.bookingOutPeriod?.S || "immediate",
        clinicSoftware:
          p.clinic_software?.S ||
          p.software_used?.S ||
          "Unknown",
        freeParkingAvailable: p.free_parking_available?.BOOL || false,
        parkingType: p.parking_type?.S || "N/A",
        primaryPracticeArea: p.primary_practice_area?.S || "General",
        practiceType: p.practice_type?.S || "General",
      };

      // Build DynamoDB item for temporary job
      const item = {
        clinicId: { S: clinicId },
        clinicUserSub: { S: userSub },
        jobId: { S: jobId },
        job_type: { S: "temporary" },
        professional_role: { S: jobData.professional_role },
        date: { S: jobData.date },
        shift_speciality: { S: jobData.shift_speciality },
        hours: { N: jobData.hours.toString() },
        meal_break: { S: jobData.meal_break || "" },
        hourly_rate: { N: jobData.hourly_rate.toString() },
        start_time: { S: jobData.start_time },
        end_time: { S: jobData.end_time },
        addressLine1: { S: clinicAddress.addressLine1 },
        addressLine2: { S: clinicAddress.addressLine2 },
        addressLine3: { S: clinicAddress.addressLine3 },
        fullAddress: {
          S: `${clinicAddress.addressLine1} ${clinicAddress.addressLine2} ${clinicAddress.addressLine3}, ${clinicAddress.city}, ${clinicAddress.state} ${clinicAddress.pincode}`.replace(
            /\s+/g,
            " "
          ).trim(),
        },
        city: { S: clinicAddress.city },
        state: { S: clinicAddress.state },
        pincode: { S: clinicAddress.pincode },
        bookingOutPeriod: { S: profileData.bookingOutPeriod },
        clinicSoftware: { S: profileData.clinicSoftware },
        freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
        parkingType: { S: profileData.parkingType },
        practiceType: { S: profileData.practiceType },
        primaryPracticeArea: { S: profileData.primaryPracticeArea },
        status: { S: "active" },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
      };

      // Add optional fields
      if (jobData.job_title) item.job_title = { S: jobData.job_title };
      if (jobData.job_description) item.job_description = { S: jobData.job_description };
      if (jobData.requirements && jobData.requirements.length > 0) {
        item.requirements = { SS: jobData.requirements };
      }

      // Insert the job into DynamoDB
      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.JOB_POSTINGS_TABLE,
          Item: item,
        })
      );
    });

    // Wait for all jobs to be posted
    await Promise.all(postJobsPromises);

    return {
      statusCode: 201,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: "Temporary job postings created successfully for multiple clinics",
        jobIds,
        job_type: "temporary",
        professional_role: jobData.professional_role,
        date: jobData.date,
        hours: jobData.hours,
        hourly_rate: jobData.hourly_rate,
        total_pay: `$${(jobData.hours * jobData.hourly_rate).toFixed(2)}`,
      }),
    };
  } catch (error) {
    console.error("Error creating temporary job postings:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.handler = handler;
