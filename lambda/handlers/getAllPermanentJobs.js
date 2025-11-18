"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, QueryCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
};

// --- helper: get all jobIds this professional has applied to ---
async function getAppliedJobIdsForUser(userSub) {
  const table = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";
  const index = process.env.APPS_BY_PRO_SUB_INDEX || "professionalUserSub-index";

  const ids = new Set();
  let ExclusiveStartKey;
  do {
    const resp = await dynamodb.send(new QueryCommand({
      TableName: table,
      IndexName: index,
      KeyConditionExpression: "professionalUserSub = :sub",
      ProjectionExpression: "jobId",
      ExpressionAttributeValues: { ":sub": { S: userSub } },
      ExclusiveStartKey,
    }));
    (resp.Items || []).forEach(it => it.jobId?.S && ids.add(it.jobId.S));
    ExclusiveStartKey = resp.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return ids;
}

const handler = async (event) => {
  try {
    const method = event?.requestContext?.http?.method || event?.httpMethod || "GET";
    if (method === "OPTIONS") return { statusCode: 204, headers: CORS, body: "" };

    // ✅ must await to get the actual userSub string
    const userSub = await validateToken(event);

    // 1) Scan permanent jobs only
    const jobsCommand = new ScanCommand({
      TableName: process.env.JOB_POSTINGS_TABLE,
      FilterExpression: "job_type = :jobType",
      ExpressionAttributeValues: {
        ":jobType": { S: "permanent" }
      }
    });
    const jobResponse = await dynamodb.send(jobsCommand);
    const items = jobResponse.Items || [];

    // 2) Exclude jobs the pro already applied to
    const appliedJobIds = await getAppliedJobIdsForUser(userSub);
    const visibleItems = items.filter(it => !appliedJobIds.has(it.jobId?.S));

    // 3) Map visible items to your response shape
    const jobs = visibleItems.map(job => {
      return {
        jobId: job.jobId?.S || '',
        jobType: job.job_type?.S || '',
        clinicUserSub: job.clinicUserSub?.S || '',
        clinicId: job.clinicId?.S || '',
        professionalRole: job.professional_role?.S || '',
        jobTitle: job.job_title?.S || `${job.professional_role?.S || 'Professional'} Permanent Position`,
        description: job.job_description?.S || '',
        requirements: job.requirements?.SS || [],
        payType: job.work_schedule?.S || '',
        startDate: job.start_date?.S || '',
        shiftSpeciality: job.shift_speciality?.S || "",
        SoftwareRequired: job.clinicSoftware?.S || "",
        schedule: {
          workingDays: job.working_days?.SS || [],
          startTime: job.start_time?.S || '',
          endTime: job.end_time?.S || '',
          hoursPerWeek: job.hours_per_week?.N ? parseFloat(job.hours_per_week.N) : 0
        },
        freeParkingAvailable: job.freeParkingAvailable?.BOOL || false,
        parkingType: job.parkingType?.S || '',
        parkingRate: job.parking_rate?.N ? parseFloat(job.parking_rate.N) : 0,
        compensation: {
          salaryRange: {
            min: job.salary_min?.N ? parseFloat(job.salary_min.N) : 0,
            max: job.salary_max?.N ? parseFloat(job.salary_max.N) : 0
          },
          bonusStructure: job.bonus_structure?.S || '',
          benefits: job.benefits?.SS || []
        },
        location: {
          addressLine1: job.addressLine1?.S || '',
          addressLine2: job.addressLine2?.S || '',
          addressLine3: job.addressLine3?.S || '',
          city: job.city?.S || '',
          state: job.state?.S || '',
          zipCode: job.pincode?.S || ''
        },
        contactInfo: {
          email: job.contact_email?.S || '',
          phone: job.contact_phone?.S || ''
        },
        specialRequirements: job.special_requirements?.SS || [],
        equipmentProvided: job.equipment_provided?.SS || [],
        parkingInfo: job.parking_info?.S || '',
        careerPath: job.career_path?.S || '',
        mentorshipAvailable: job.mentorship_available?.BOOL || false,
        continuingEducationSupport: job.continuing_education_support?.BOOL || false,
        relocationAssistance: job.relocation_assistance?.BOOL || false,
        visaSponsorship: job.visa_sponsorship?.BOOL || false,
        status: job.status?.S || 'active',
        createdAt: job.created_at?.S || '',
        updatedAt: job.updated_at?.S || '',
        applicationCount: 0,
        applicationsEnabled: job.status?.S === 'active'
      };
    });

    return {
      statusCode: 200,
      headers: CORS,
      body: JSON.stringify({
        message: "Permanent jobs retrieved successfully",
        excludedCount: appliedJobIds.size,   // helpful for quick verification
        jobs
      }),
    };
  } catch (error) {
    console.error("Error retrieving permanent jobs:", error);
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({
        error: "Failed to retrieve permanent jobs. Please try again.",
        details: error?.message || String(error)
      }),
    };
  }
};

exports.handler = handler;