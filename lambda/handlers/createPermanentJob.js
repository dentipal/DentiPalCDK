"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./utils");
const { VALID_ROLE_VALUES } = require("./professionalRoles");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ---------- group helpers ----------
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

// ---------- validation helpers ----------
const validateTemporaryJob = (jobData) => {
  if (!jobData.date || !jobData.hours || !jobData.hourly_rate) {
    return "Temporary job requires: date, hours, hourly_rate";
  }
  const jobDate = new Date(jobData.date);
  if (isNaN(jobDate.getTime())) {
    return "Invalid date format. Use ISO date string.";
  }
  if (jobData.hours < 1 || jobData.hours > 12) {
    return "Hours must be between 1 and 12";
  }
  if (jobData.hourly_rate < 10 || jobData.hourly_rate > 200) {
    return "Hourly rate must be between $10 and $200";
  }
  return null;
};

const validatePermanentJob = (jobData) => {
  if (!jobData.employment_type || !jobData.salary_min || !jobData.salary_max || !jobData.benefits) {
    return "Permanent job requires: employment_type, salary_min, salary_max, benefits";
  }
  if (jobData.salary_max < jobData.salary_min) {
    return "Maximum salary must be greater than minimum salary";
  }
  if (!Array.isArray(jobData.benefits)) {
    return "Benefits must be an array";
  }
  const validEmploymentTypes = ["full_time", "part_time"];
  if (!validEmploymentTypes.includes(jobData.employment_type)) {
    return `Invalid employment_type. Valid options: ${validEmploymentTypes.join(", ")}`;
  }
  return null;
};

// ---------- small helpers ----------
async function getClinicProfileByUser(clinicId, userSub) {
  const res = await dynamodb.send(
    new GetItemCommand({
      TableName: process.env.CLINIC_PROFILES_TABLE,
      Key: { clinicId: { S: clinicId }, userSub: { S: userSub } }
    })
  );
  return res.Item || null;
}

const handler = async (event) => {
  try {
    const userSub = await validateToken(event); // clinic user

    // ---- Group authorization (Root, ClinicAdmin, ClinicManager only) ----
    const rawGroups = parseGroupsFromAuthorizer(event);
    const normalized = rawGroups.map(normalizeGroup);
    const isAllowed = normalized.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return {
        statusCode: 403,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
        body: JSON.stringify({ error: "Access denied: only Root, ClinicAdmin, or ClinicManager can create jobs" })
      };
    }
    // --------------------------------------------------------------------

    const jobData = JSON.parse(event.body);

    // Validate common required fields
    if (!jobData.job_type || !jobData.professional_role || !jobData.shift_speciality || !jobData.clinicIds || !Array.isArray(jobData.clinicIds)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
        body: JSON.stringify({
          error: "Required fields: job_type, professional_role, shift_speciality, clinicIds (array)"
        })
      };
    }

    // Validate job type
    const validJobTypes = ["temporary", "multi_day_consulting", "permanent"];
    if (!validJobTypes.includes(jobData.job_type)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
        body: JSON.stringify({
          error: `Invalid job_type. Valid options: ${validJobTypes.join(", ")}`
        })
      };
    }

    // Validate professional role
    if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
        body: JSON.stringify({
          error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(", ")}`
        })
      };
    }

    // Job type specific validation
    let validationError = null;
    switch (jobData.job_type) {
      case "temporary":
        validationError = validateTemporaryJob(jobData);
        break;
      case "permanent":
        validationError = validatePermanentJob(jobData);
        break;
    }

    if (validationError) {
      return {
        statusCode: 400,
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "POST, OPTIONS",
          "Access-Control-Allow-Headers": "Authorization, Content-Type",
        },
        body: JSON.stringify({ error: validationError })
      };
    }

    const timestamp = new Date().toISOString();
    const jobIds = []; // To store the generated jobIds for all clinics

    // Loop through each clinicId and post the job
    const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
      const jobId = uuidv4(); // unique per clinic
      jobIds.push(jobId);

      // Fetch clinic (address + owner)
      const clinicResponse = await dynamodb.send(
        new GetItemCommand({
          TableName: process.env.CLINICS_TABLE,
          Key: { clinicId: { S: clinicId } }
        })
      );
      if (!clinicResponse.Item) {
        throw new Error(`Clinic not found: ${clinicId}`);
      }

      const clinicItem = clinicResponse.Item;
      const clinicAddress = {
        addressLine1: clinicItem.addressLine1?.S || "",
        addressLine2: clinicItem.addressLine2?.S || "",
        fullAddress: `${clinicItem.addressLine1?.S || ""} ${clinicItem.addressLine2?.S || ""}`.replace(/\s+/g, " ").trim(),
        city: clinicItem.city?.S || "",
        state: clinicItem.state?.S || "",
        pincode: clinicItem.pincode?.S || ""
      };
      const clinicOwnerSub = clinicItem.createdBy?.S;

      // Fetch clinic profile: try current user first, then owner; otherwise defaults
      let profileItem = await getClinicProfileByUser(clinicId, userSub);
      if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
        try {
          profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
        } catch {}
      }

      const p = profileItem || {};
      const profileData = {
        bookingOutPeriod: p.bookingOutPeriod?.S || p.booking_out_period?.S || "immediate",
        clinicSoftware: p.softwareUsed?.S || p.software_used?.S || "Unknown",
        freeParkingAvailable: p.free_parking_available?.BOOL || false,
        parkingType: p.parking_type?.S || "N/A",
        practiceType: p.practiceType?.S || p.practice_type?.S || "General",
        primaryPracticeArea: p.primaryPracticeArea?.S || p.primary_practice_area?.S || "General Dentistry"
      };

      // Build job posting item for DynamoDB
      const item = {
        clinicId: { S: clinicId },
        clinicUserSub: { S: userSub },
        jobId: { S: jobId },
        job_type: { S: jobData.job_type },
        professional_role: { S: jobData.professional_role },
        shift_speciality: { S: jobData.shift_speciality },
        status: { S: "active" },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
        addressLine1: { S: clinicAddress.addressLine1 },
        addressLine2: { S: clinicAddress.addressLine2 },
        fullAddress: { S: clinicAddress.fullAddress },
        city: { S: clinicAddress.city },
        state: { S: clinicAddress.state },
        pincode: { S: clinicAddress.pincode },
        bookingOutPeriod: { S: profileData.bookingOutPeriod },
        clinicSoftware: { S: profileData.clinicSoftware },
        freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
        parkingType: { S: profileData.parkingType },
        practiceType: { S: profileData.practiceType },
        primaryPracticeArea: { S: profileData.primaryPracticeArea }
      };

      // Optional fields shared across types
      if (jobData.job_title) item.job_title = { S: jobData.job_title };
      if (jobData.job_description) item.job_description = { S: jobData.job_description };
      if (jobData.requirements && jobData.requirements.length > 0) {
        item.requirements = { SS: jobData.requirements };
      }

      // Job type specific fields
      if (jobData.job_type === "permanent") {
        item.employment_type = { S: jobData.employment_type };
        item.salary_min = { N: jobData.salary_min.toString() };
        item.salary_max = { N: jobData.salary_max.toString() };
        item.benefits = { SS: jobData.benefits };
        if (jobData.vacation_days) {
          item.vacation_days = { N: jobData.vacation_days.toString() };
        }
        if (jobData.work_schedule) {
          item.work_schedule = { S: jobData.work_schedule };
        }
        if (jobData.start_date) {
          item.start_date = { S: jobData.start_date };
        }
      }

      // Insert the job into DynamoDB
      await dynamodb.send(new PutItemCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        Item: item
      }));
    });

    await Promise.all(postJobsPromises);

    return {
      statusCode: 201,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
      body: JSON.stringify({
        message: "Job posting created for multiple clinics",
        jobIds: jobIds
      })
    };
  } catch (error) {
    console.error("Error creating job posting:", error);
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
      },
      body: JSON.stringify({ error: error.message })
    };
  }
};

exports.handler = handler;
