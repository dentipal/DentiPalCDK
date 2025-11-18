"use strict";
const {
  DynamoDBClient,
  QueryCommand,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { unmarshall } = require("@aws-sdk/util-dynamodb"); // Correct import
const { validateToken } = require("./utils");

const REGION = process.env.REGION || process.env.AWS_REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE;
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE;
const CLINIC_GSI = process.env.CLINIC_ID_INDEX || "ClinicIdIndex";

const dynamodb = new DynamoDBClient({ region: REGION });

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Credentials": true,
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "OPTIONS,GET",
};

// --- robust clinicId extraction for both /jobs/multiday/{clinicId} and /jobs/multiday/clinic/{clinicId}
function extractClinicId(event) {
  if (event.pathParameters?.clinicId) return event.pathParameters.clinicId;

  const raw = event.pathParameters?.proxy || event.path || "";
  const parts = raw.split("/").filter(Boolean);
  const idxMulti = parts.findIndex((s) => s.toLowerCase() === "multiday");
  if (idxMulti >= 0) {
    if (parts[idxMulti + 1]?.toLowerCase() === "clinic") return parts[idxMulti + 2];
    return parts[idxMulti + 1];
  }
  return parts[parts.length - 1];
}

exports.handler = async (event) => {
  console.log("📥 Event:", JSON.stringify({ path: event.path, resource: event.resource, pathParameters: event.pathParameters }, null, 2));

  try {
    const userSub = await validateToken(event);
    console.log("✅ Auth userSub:", userSub);

    const clinicId = extractClinicId(event);
    console.log("🏥 Extracted clinicId:", clinicId);

    if (!clinicId || clinicId.toLowerCase() === "clinic") {
      console.warn("⚠️ clinicId missing or parsed as literal 'clinic'");
      return {
        statusCode: 400,
        headers: corsHeaders,
        body: JSON.stringify({ error: "clinicId is required in path" }),
      };
    }

    // 1) Query postings by ClinicIdIndex
    const q = new QueryCommand({
      TableName: JOB_POSTINGS_TABLE,
      IndexName: CLINIC_GSI,
      KeyConditionExpression: "clinicId = :cid",
      ExpressionAttributeValues: { ":cid": { S: clinicId } },
    });
    console.log("📤 Querying", { table: JOB_POSTINGS_TABLE, index: CLINIC_GSI, clinicId });
    const qr = await dynamodb.send(q);
    // console.log("📦 Raw Items from DynamoDB Query:", JSON.stringify(qr.Items, null, 2)); // Removed after pinpointing issue

    const allJobs = (qr.Items || []).map(unmarshall);
    // console.log("🧾 Unmarshalled Jobs (after unmarshall):", JSON.stringify(allJobs, null, 2)); // Removed after pinpointing issue

    // 2) Strictly filter for multi_day_consulting jobs
    const consultingJobs = allJobs.filter((j) => {
      const isMultiDay = j.job_type === "multi_day_consulting" || j.jobType === "multi_day_consulting";
      if (!isMultiDay) {
        console.warn(`Job ${j.jobId} skipped: job_type '${j.job_type || "missing"}' is not multi_day_consulting`);
      }
      return isMultiDay;
    });
    console.log(`🎯 Filtered multiday: ${consultingJobs.length} of ${allJobs.length}`);

    // 3) Fetch clinic profile for enrichment
    let clinicProfile = {};
    try {
      const g = await dynamodb.send(
        new GetItemCommand({
          TableName: CLINIC_PROFILES_TABLE,
          Key: { clinicId: { S: clinicId }, userSub: { S: userSub } },
        })
      );
      clinicProfile = unmarshall(g.Item || {});
    } catch (e) {
      console.warn("⚠️ Clinic profile fetch failed:", e);
    }
    console.log("👤 Clinic Profile:", JSON.stringify(clinicProfile, null, 2));


    // 4) Build response objects
    const jobs = consultingJobs.map((job) => {
      // --- CORRECTED LOGIC FOR DATES AND REQUIREMENTS/BENEFITS ---
      let jobDates = [];
      let jobRequirements = [];
      let jobBenefits = [];

      // Debugging the type and value of job.dates after unmarshall
      console.log(`DEBUG: Job ID ${job.jobId} - job.dates type: ${typeof job.dates}, value:`, job.dates);

      // Handle dates which unmarshall converts to a Set from SS
      if (job.dates instanceof Set) {
        jobDates = Array.from(job.dates);
      } else if (Array.isArray(job.dates)) {
        jobDates = job.dates; // Fallback for pure array, though Set is expected for SS
      } else if (typeof job.dates === 'string' && job.dates.includes(',')) {
          // Fallback for comma-separated string if schema unexpectedly changes
          jobDates = job.dates.split(',').map(date => date.trim());
          console.warn(`WARN: Job ID ${job.jobId} - 'dates' was a comma-separated string, parsed into array.`);
      } else if (typeof job.dates === 'string' && job.dates.length > 0) {
          // Fallback for single date string
          jobDates = [job.dates];
          console.warn(`WARN: Job ID ${job.jobId} - 'dates' was a single date string, converted to array.`);
      }

      // Handle requirements and benefits - assuming they are also String Sets (SS) or Lists (L)
      if (job.requirements instanceof Set) {
        jobRequirements = Array.from(job.requirements);
      } else if (Array.isArray(job.requirements)) {
        jobRequirements = job.requirements;
      }
      
      if (job.benefits instanceof Set) {
        jobBenefits = Array.from(job.benefits);
      } else if (Array.isArray(job.benefits)) {
        jobBenefits = job.benefits;
      }

      // If 'benefits' is empty but 'requirements' is populated (common alias)
      if (jobBenefits.length === 0 && jobRequirements.length > 0) {
          jobBenefits = jobRequirements;
      }


      return {
        jobId: job.jobId || "",
        jobType: job.job_type || job.jobType || "multi_day_consulting",
        professionalRole: job.professional_role || job.professionalRole || "",
        jobTitle: job.job_title || `${job.professional_role || 'Professional'} Consulting Position`, // From reference
        description: job.job_description || "", // From reference
        requirements: jobRequirements, // Ensure it's an array
        dates: jobDates, // This will now correctly be the array of dates
        startTime: job.start_time || "", // From reference
        endTime: job.end_time || "", // From reference
        mealBreak: job.meal_break ?? false, // From reference, handles BOOL
        hourlyRate: job.hourly_rate ? parseFloat(job.hourly_rate) : 0, // From reference, handles N
        totalDays: jobDates.length, // From reference
        shiftSpeciality: job.shift_speciality || job.shiftSpeciality || "",
        employmentType: job.employment_type || job.employmentType || "",
        status: job.status || "active",
        addressLine1: job.addressLine1 || job.address_line1 || "",
        addressLine2: job.addressLine2 || job.address_line2 || "",
        addressLine3: job.addressLine3 || job.address_line3 || "",
        fullAddress: job.fullAddress || `${job.addressLine1 || job.address_line1 || ""} ${job.addressLine2 || job.address_line2 || ""} ${job.addressLine3 || job.address_line3 || ""}`.trim(),
        city: job.city || "",
        state: job.state || "",
        pincode: job.zipCode || job.pincode || "",
        // Using clinicProfile for enrichment as in your previous code
        bookingOutPeriod: clinicProfile.booking_out_period || clinicProfile.bookingOutPeriod || job.bookingOutPeriod || "immediate",
        clinicSoftware: clinicProfile.clinic_software || clinicProfile.clinicSoftware || job.clinicSoftware || "Unknown",
        freeParkingAvailable: clinicProfile.free_parking_available ?? clinicProfile.freeParkingAvailable ?? job.freeParkingAvailable ?? false,
        parkingType: clinicProfile.parking_type || clinicProfile.parkingType || job.parkingType || "N/A",
        practiceType: clinicProfile.practice_type || clinicProfile.practiceType || job.practiceType || "General",
        primaryPracticeArea: clinicProfile.primary_practice_area || clinicProfile.primaryPracticeArea || job.primaryPracticeArea || "General Dentistry",
        createdAt: job.createdAt || "",
        updatedAt: job.updatedAt || "",
        // applicationCount and applicationsEnabled are not available in this "all jobs by clinicId" context
        // These fields would typically be added when fetching a *single* job by its jobId,
        // as the "applicationsEnabled" relies on the job's status.
        // If you need applicationCount for *each* job in this list, you'd need a sub-query/scan for each job,
        // which is inefficient for a list endpoint.
        // For this endpoint, we'll omit applicationCount and applicationsEnabled unless explicitly requested
        // with a clear, efficient way to obtain them for multiple jobs.
      };
    });

    console.log("✅ Returning jobs count:", jobs.length);

    return {
      statusCode: 200,
      headers: corsHeaders,
      body: JSON.stringify({
        message: `Retrieved ${jobs.length} multi-day consulting job(s) for clinicId: ${clinicId}`,
        jobs,
      }),
    };
  } catch (err) {
    console.error("❌ Handler error:", err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({
        error: "Failed to retrieve multi-day consulting jobs",
        details: err.message,
      }),
    };
  }
};