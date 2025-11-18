"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;
const {
  DynamoDBClient,
  ScanCommand,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");

const dynamodb = new DynamoDBClient({ region: process.env.REGION || "us-east-1" });

/**
 * Helper to fetch clinic info given clinic userSub.
 * This is primarily for clinic name and contact.
 */
async function fetchClinicInfo(clinicUserSub) {
  try {
    const clinicCommand = new GetItemCommand({
      TableName: process.env.CLINIC_PROFILES_TABLE,
      Key: { userSub: { S: clinicUserSub } },
      ProjectionExpression: "clinic_name, primary_contact_first_name, primary_contact_last_name",
    });
    const clinicResponse = await dynamodb.send(clinicCommand);
    if (clinicResponse.Item) {
      const clinic = clinicResponse.Item;
      return {
        name: clinic.clinic_name?.S || "Unknown Clinic",
        contactName: (`${clinic.primary_contact_first_name?.S || ""} ${clinic.primary_contact_last_name?.S || ""}`)
          .trim() || "Contact",
      };
    }
  } catch (e) {
    console.warn(`Failed to fetch clinic details for ${clinicUserSub}:`, e);
  }
  return undefined;
}

const handler = async (event) => {
  // Define CORS headers
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent",
    "Access-Control-Allow-Methods": "OPTIONS,GET",
  };

  try {
    const jobPostings = [];
    let ExclusiveStartKey = undefined;

    // Paginate through all active jobs
    do {
      const scanParams = {
        TableName: process.env.JOB_POSTINGS_TABLE,
        FilterExpression: "#st = :active",
        ExpressionAttributeNames: { "#st": "status" },
        ExpressionAttributeValues: { ":active": { S: "active" } },
        ExclusiveStartKey,
      };

      const scanCommand = new ScanCommand(scanParams);
      const scanResponse = await dynamodb.send(scanCommand);

      if (scanResponse.Items) {
        for (const item of scanResponse.Items) {
          const job = {
            jobId: item.jobId?.S || "",
            jobType: item.job_type?.S || "",
            professionalRole: item.professional_role?.S || "",
            status: item.status?.S || "active",
            createdAt: item.createdAt?.S || "",
            updatedAt: item.updatedAt?.S || "",
          };

          // Common fields
          if (item.job_title?.S) job.jobTitle = item.job_title.S;
          if (item.job_description?.S) job.jobDescription = item.job_description.S;

          // Rate/Salary fields
          if (item.hourly_rate?.N) job.hourlyRate = parseFloat(item.hourly_rate.N);
          if (item.salary_min?.N) job.salaryMin = parseFloat(item.salary_min.N);
          if (item.salary_max?.N) job.salaryMax = parseFloat(item.salary_max.N);

          // Date/Time specific fields based on jobType
          if (item.job_type?.S === 'temporary') {
            if (item.date?.S) job.date = item.date.S; // Single date for temporary
            if (item.hours?.N) job.hours = parseFloat(item.hours.N);
            if (item.start_time?.S) job.startTime = item.start_time.S; // Added
            if (item.end_time?.S) job.endTime = item.end_time.S;     // Added
          } else if (item.job_type?.S === 'multi_day_consulting') {
            if (item.dates?.SS) job.dates = item.dates.SS; // Array of dates for multi-day
            if (item.start_time?.S) job.startTime = item.start_time.S; // Added
            if (item.end_time?.S) job.endTime = item.end_time.S;     // Added
          } else if (item.job_type?.S === 'permanent') {
            if (item.start_date?.S) job.startDate = item.start_date.S; // Added
          }


          // Location details
          if (item.city?.S) job.city = item.city.S;
          if (item.state?.S) job.state = item.state.S;
          if (item.addressLine1?.S) job.addressLine1 = item.addressLine1.S;
          if (item.addressLine2?.S) job.addressLine2 = item.addressLine2.S;
          if (item.addressLine3?.S) job.addressLine3 = item.addressLine3.S;

          // Enrich with clinic info (name, contact) if available
          const clinicUserSub = item.clinicUserSub?.S;
          if (clinicUserSub) {
            const clinicInfo = await fetchClinicInfo(clinicUserSub);
            if (clinicInfo) {
              job.clinic = clinicInfo;
            }
          }

          jobPostings.push(job);
        }
      }

      ExclusiveStartKey = scanResponse.LastEvaluatedKey;
    } while (ExclusiveStartKey);

    // Sort by createdAt descending (newest first). Fallback to 0.
    jobPostings.sort((a, b) => {
      const ta = new Date(a.createdAt).getTime() || 0;
      const tb = new Date(b.createdAt).getTime() || 0;
      return tb - ta;
    });

    return {
      statusCode: 200,
      headers: headers,
      body: JSON.stringify({
        status: "success",
        jobPostings,
        totalCount: jobPostings.length,
      }),
    };
  } catch (error) {
    console.error("Error retrieving active job postings:", error);
    return {
      statusCode: 500,
      headers: headers,
      body: JSON.stringify({
        error: `Failed to retrieve active job postings: ${error.message || "unknown"}`,
      }),
    };
  }
};

exports.handler = handler;