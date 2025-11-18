"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  DynamoDBClient,
  QueryCommand
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// CORS headers to be included in all responses
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE"
};

// --- helpers -------------------------------------------------
const pick = (obj, keys) => {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "") {
      return { key: k, value: obj[k] };
    }
  }
  return { key: null, value: undefined };
};

const toISO = (val) => {
  if (val === undefined || val === null || val === "") return "";
  // number or numeric string -> epoch ms
  if (typeof val === "number" || (/^\d+$/.test(String(val)))) {
    const n = Number(val);
    if (!Number.isNaN(n)) {
      const d = new Date(n);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
  }
  // ISO/UTC/local date string
  const d = new Date(String(val));
  if (!Number.isNaN(d.getTime())) return d.toISOString();
  // give back original if unparsable (at least user sees something)
  return String(val);
};

const getPermanentStartDate = (job) => {
  // Common field name variants you might have used
  const { key, value } = pick(job, [
    "startDate", "start_date",
    "expectedStartDate", "expected_start_date",
    "joiningDate", "joining_date", "joinDate", "join_date",
    "availableFrom", "available_from",
    "availabilityDate", "availability_date",
    "startOn", "start_on",
    "start" // last resort
  ]);

  if (value !== undefined) {
    const iso = toISO(value);
    return { startDate: iso, source: key };
  }

  // Fallback: earliest date in a dates array if present
  if (Array.isArray(job.dates) && job.dates.length) {
    const validDates = job.dates
      .map((v) => new Date(v))
      .filter((d) => !Number.isNaN(d.getTime()))
      .sort((a, b) => a.getTime() - b.getTime());
    if (validDates.length) {
      return { startDate: validDates[0].toISOString(), source: "dates[0]" };
    }
  }

  return { startDate: "", source: null };
};
// ------------------------------------------------------------

const handler = async (event) => {
  console.log("📥 Incoming Event:", JSON.stringify(event, null, 2));

  try {
    const userSub = await validateToken(event);
    console.log("✅ User authenticated. userSub:", userSub);

    // Extract clinicId from proxy path: e.g. "jobs/clinicpermanent/{clinicId}"
    const pathParts = event.pathParameters?.proxy?.split('/') || [];
    console.log("🔍 Extracted pathParts:", pathParts);
    const clinicId = pathParts[2];
    console.log("🔍 Extracted clinicId:", clinicId);

    if (!clinicId) {
      console.warn("⚠️ clinicId missing in path");
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "clinicId is required in path" })
      };
    }

    // Query using ClinicIdIndex
    const queryCommand = new QueryCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      IndexName: "ClinicIdIndex",
      KeyConditionExpression: "clinicId = :clinicId",
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId }
      }
    });

    console.log("📤 Sending query to DynamoDB (ClinicIdIndex)...");
    const result = await dynamodb.send(queryCommand);
    console.log("📦 Raw query result count:", result?.Count || 0);

    const allJobs = (result.Items || []).map(unmarshall);
    console.log("🧾 Unmarshalled jobs sample:", JSON.stringify(allJobs.slice(0, 3), null, 2));

    // Accept both snake_case and camelCase for type
    const permanentJobs = allJobs.filter(
      (job) => job.job_type === "permanent" || job.jobType === "permanent"
    );
    console.log(`🎯 Filtered ${permanentJobs.length} permanent job(s)`);

    const formattedJobs = permanentJobs.map((job, idx) => {
      const { startDate, source } = getPermanentStartDate(job);
      console.log(`🗓️  Job[${idx}] startDate ->`, { value: startDate, source });

      // Prefer snake_case -> camelCase fallbacks everywhere
      const salaryMinRaw = job.salary_min ?? job.salaryMin;
      const salaryMaxRaw = job.salary_max ?? job.salaryMax;

      const formatted = {
        jobId: job.jobId || "",
        jobType: job.job_type || job.jobType || "permanent",
        professionalRole: job.professional_role || job.professionalRole || "",
        shiftSpeciality: job.shift_speciality || job.shiftSpeciality || "",
        employmentType: job.employment_type || job.employmentType || "",
        salaryMin: typeof salaryMinRaw === "number" ? salaryMinRaw : parseFloat(salaryMinRaw || 0),
        salaryMax: typeof salaryMaxRaw === "number" ? salaryMaxRaw : parseFloat(salaryMaxRaw || 0),
        benefits: job.benefits || {},
        status: job.status || "active",
        addressLine1: job.addressLine1 || job.address_line1 || "",
        addressLine2: job.addressLine2 || job.address_line2 || "",
        addressLine3: job.addressLine3 || job.address_line3 || "",
        fullAddress: `${job.addressLine1 || job.address_line1 || ""} ${job.addressLine2 || job.address_line2 || ""} ${job.addressLine3 || job.address_line3 || ""}`.trim(),
        city: job.city || "",
        state: job.state || "",
        pincode: job.pincode || job.zipCode || "",
        bookingOutPeriod: job.bookingOutPeriod || job.booking_out_period || "immediate",
        clinicSoftware: job.clinicSoftware || job.clinic_software || "Unknown",
        freeParkingAvailable: (job.freeParkingAvailable ?? job.free_parking_available) || false,
        parkingType: job.parkingType || job.parking_type || "On-site",
        practiceType: job.practiceType || job.practice_type || "General Dentistry",
        primaryPracticeArea: job.primaryPracticeArea || job.primary_practice_area || "General Dentistry",
        // 🎯 NEW:
        startDate, // ISO if parsable, else original string or ""
        createdAt: job.createdAt || "",
        updatedAt: job.updatedAt || ""
      };

      console.log(`🧩 Formatted job [${idx + 1}]:`, formatted);
      return formatted;
    });

    console.log("✅ All permanent jobs formatted successfully");

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: `Retrieved ${formattedJobs.length} permanent job(s) for clinicId: ${clinicId}`,
        jobs: formattedJobs
      })
    };

  } catch (error) {
    console.error("❌ Error during Lambda execution:", error);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Failed to retrieve permanent jobs",
        details: error.message
      })
    };
  }
};

exports.handler = handler;
