"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, GetItemCommand, PutItemCommand } = require("@aws-sdk/client-dynamodb");
const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./utils");
const { VALID_ROLE_VALUES } = require("./professionalRoles"); // ensure path is correct

const dynamodb = new DynamoDBClient({ region: process.env.REGION || process.env.AWS_REGION || "us-east-1" });

// ---------- CORS helpers ----------
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
  "Content-Type": "application/json",
};
const resp = (statusCode, data) => ({
  statusCode,
  headers: CORS_HEADERS,
  body: typeof data === "string" ? data : JSON.stringify(data),
});

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

// ---------- misc helpers ----------
const normalizeWs = (s = "") => String(s).replace(/\s+/g, " ").trim();
/** Try to parse a human string into minutes. Returns number or null if unknown. */
function parseMealBreakMinutes(input) {
  if (!input) return null;
  const s = input.trim();

  // common "no break" variants
  if (/^(no(\s*break)?|none|n\/?a|nil)$/i.test(s)) return 0;

  // HH:MM (e.g., 01:00, 0:30)
  let m = s.match(/^(\d{1,2}):([0-5]?\d)$/);
  if (m) return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);

  const lower = s.toLowerCase();

  // "1.5h", "1 h", "1 hour", "2 hours"
  m = lower.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hour|hours)$/);
  if (m) return Math.round(parseFloat(m[1]) * 60);

  // "90min", "30 minutes"
  m = lower.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minute|minutes)$/);
  if (m) return Math.round(parseFloat(m[1]));

  // Just a bare number -> assume minutes (e.g., "30")
  m = lower.match(/^(\d+(?:\.\d+)?)$/);
  if (m) return Math.round(parseFloat(m[1]));

  return null; // keep original string only
}

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
  const method = event?.httpMethod || event?.requestContext?.http?.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: CORS_HEADERS, body: "" };

  try {
    // Auth
    const userSub = await validateToken(event);

    // Group authorization (Root, ClinicAdmin, ClinicManager only)
    const rawGroups = parseGroupsFromAuthorizer(event);
    const normalizedGroups = rawGroups.map(normalizeGroup);
    const isAllowed = normalizedGroups.some(g => ALLOWED_GROUPS.has(g));
    if (!isAllowed) {
      return resp(403, { error: "Access denied: only Root, ClinicAdmin, or ClinicManager can create consulting projects" });
    }

    const jobData = JSON.parse(event.body || "{}");

    // Required fields
    if (
      !jobData.clinicIds ||
      !Array.isArray(jobData.clinicIds) ||
      jobData.clinicIds.length === 0 ||
      !jobData.professional_role ||
      !jobData.dates ||
      !jobData.shift_speciality ||
      !jobData.hours_per_day ||
      !jobData.hourly_rate ||
      !jobData.total_days ||
      !jobData.start_time ||
      !jobData.end_time
    ) {
      return resp(400, {
        error:
          "Required fields: clinicIds (array), professional_role, dates, shift_speciality, hours_per_day, hourly_rate, total_days, start_time, end_time",
      });
    }

    if (!VALID_ROLE_VALUES.includes(jobData.professional_role)) {
      return resp(400, { error: `Invalid professional_role. Valid options: ${VALID_ROLE_VALUES.join(", ")}` });
    }

    // dates
    if (!Array.isArray(jobData.dates) || jobData.dates.length === 0) {
      return resp(400, { error: "Dates must be a non-empty array" });
    }
    if (jobData.dates.length > 30) {
      return resp(400, { error: "Maximum 30 days allowed for consulting projects" });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (const d of jobData.dates) {
      const dt = new Date(d);
      if (isNaN(dt.getTime())) return resp(400, { error: `Invalid date format: ${d}. Use ISO date string.` });
      if (dt < today) return resp(400, { error: `All dates must be in the future. Invalid date: ${d}` });
    }

    const uniqueDates = new Set(jobData.dates);
    if (uniqueDates.size !== jobData.dates.length) {
      return resp(400, { error: "Duplicate dates are not allowed" });
    }

    if (jobData.dates.length !== jobData.total_days) {
      return resp(400, {
        error: `Number of dates (${jobData.dates.length}) must match total_days (${jobData.total_days})`,
      });
    }

    const hoursPerDay = Number(jobData.hours_per_day);
    const hourlyRate = Number(jobData.hourly_rate);
    if (!Number.isFinite(hoursPerDay) || hoursPerDay < 1 || hoursPerDay > 12) {
      return resp(400, { error: "Hours per day must be a number between 1 and 12" });
    }
    if (!Number.isFinite(hourlyRate) || hourlyRate < 10 || hourlyRate > 300) {
      return resp(400, { error: "Hourly rate must be a number between $10 and $300 for consulting" });
    }

    // ---------- meal_break: generic string + optional minutes ----------
    const mealBreakRaw = typeof jobData.meal_break === "string" ? normalizeWs(jobData.meal_break) : "";
    if (mealBreakRaw && mealBreakRaw.length > 100) {
      return resp(400, { error: "meal_break must be 100 characters or fewer" });
    }
    const mealBreakMinutes = mealBreakRaw ? parseMealBreakMinutes(mealBreakRaw) : null;
    // ------------------------------------------------------------------

    const timestamp = new Date().toISOString();
    const sortedDates = [...jobData.dates].sort();
    const jobIds = []; // To store the generated jobIds for all clinics

    // Loop through each clinicId and post the job
    const postJobsPromises = jobData.clinicIds.map(async (clinicId) => {
      const jobId = uuidv4(); // Generate unique job ID for each clinic
      jobIds.push(jobId); // Collect jobId for response

      // clinic address & owner
      const clinicResponse = await dynamodb.send(
        new GetItemCommand({
          TableName: process.env.CLINICS_TABLE,
          Key: { clinicId: { S: clinicId } },
        })
      );
      if (!clinicResponse.Item) throw new Error(`Clinic not found: ${clinicId}`);

      const clinicAddress = {
        addressLine1: clinicResponse.Item.addressLine1?.S || "",
        addressLine2: clinicResponse.Item.addressLine2?.S || "",
        addressLine3: clinicResponse.Item.addressLine3?.S || "",
        city: clinicResponse.Item.city?.S || "",
        state: clinicResponse.Item.state?.S || "",
        pincode: clinicResponse.Item.pincode?.S || "",
      };
      const clinicOwnerSub = clinicResponse.Item.createdBy?.S;

      // clinic profile: try manager's row -> fallback to clinic owner's row -> defaults
      let profileItem = await getClinicProfileByUser(clinicId, userSub);
      if (!profileItem && clinicOwnerSub && clinicOwnerSub !== userSub) {
        try {
          profileItem = await getClinicProfileByUser(clinicId, clinicOwnerSub);
        } catch {}
      }
      const p = profileItem || {};
      const profileData = {
        bookingOutPeriod: p.booking_out_period?.S || "immediate",
        practiceType: p.practice_type?.S || "General",
        primaryPracticeArea: p.primary_practice_area?.S || "General Dentistry",
        clinicSoftware: p.clinic_software?.S || p.software_used?.S || "Unknown",
        freeParkingAvailable: p.free_parking_available?.BOOL || false,
        parkingType: p.parking_type?.S || "N/A",
      };

      // Build dynamo item
      const item = {
        clinicId: { S: clinicId },
        clinicUserSub: { S: userSub },
        jobId: { S: jobId },
        job_type: { S: "multi_day_consulting" },
        professional_role: { S: jobData.professional_role },
        dates: { L: sortedDates.map(d => ({ S: d })) },
        shift_speciality: { S: jobData.shift_speciality },
        hours_per_day: { N: String(hoursPerDay) },
        total_days: { N: String(jobData.total_days) },
        hourly_rate: { N: String(hourlyRate) },
        start_time: { S: jobData.start_time },
        end_time: { S: jobData.end_time },
        status: { S: "active" },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
        addressLine1: { S: clinicAddress.addressLine1 },
        addressLine2: { S: clinicAddress.addressLine2 },
        addressLine3: { S: clinicAddress.addressLine3 },
        city: { S: clinicAddress.city },
        state: { S: clinicAddress.state },
        pincode: { S: clinicAddress.pincode },
        fullAddress: {
          S: `${clinicAddress.addressLine1} ${clinicAddress.addressLine2} ${clinicAddress.addressLine3}, ${clinicAddress.city}, ${clinicAddress.state} ${clinicAddress.pincode}`.replace(/\s+/g, " ").trim(),
        },
        bookingOutPeriod: { S: profileData.bookingOutPeriod },
        practiceType: { S: profileData.practiceType },
        primaryPracticeArea: { S: profileData.primaryPracticeArea },
        clinicSoftware: { S: profileData.clinicSoftware },
        freeParkingAvailable: { BOOL: profileData.freeParkingAvailable },
        parkingType: { S: profileData.parkingType },
      };

      // Only add meal_break attributes if provided
      if (mealBreakRaw) {
        item.meal_break = { S: mealBreakRaw };
        if (mealBreakMinutes !== null) {
          item.meal_break_minutes = { N: String(mealBreakMinutes) };
        }
      }

      if (jobData.project_duration) item.project_duration = { S: jobData.project_duration };
      if (jobData.job_title) item.job_title = { S: jobData.job_title };
      if (jobData.job_description) item.job_description = { S: jobData.job_description };
      if (Array.isArray(jobData.requirements) && jobData.requirements.length > 0) {
        item.requirements = { SS: jobData.requirements };
      }

      await dynamodb.send(new PutItemCommand({ TableName: process.env.JOB_POSTINGS_TABLE, Item: item }));
    });

    // Wait for all jobs to be posted
    await Promise.all(postJobsPromises);

    const totalHours = Number(jobData.total_days) * hoursPerDay;
    const totalPay = totalHours * hourlyRate;

    return resp(201, {
      message: "Multi-day consulting projects created successfully for multiple clinics",
      jobIds,
      job_type: "multi_day_consulting",
      professional_role: jobData.professional_role,
      dates: sortedDates,
      total_days: jobData.total_days,
      hours_per_day: hoursPerDay,
      hourly_rate: hourlyRate,
      meal_break: mealBreakRaw || null,
      meal_break_minutes: mealBreakMinutes, // nullable
      total_hours: totalHours,
      total_compensation: `$${totalPay.toLocaleString()}`,
      start_date: sortedDates[0],
      end_date: sortedDates[sortedDates.length - 1],
    });
  } catch (error) {
    console.error("Error creating multi-day consulting project:", error);
    return resp(500, { error: error?.message || "Internal Server Error" });
  }
};

exports.handler = handler;
