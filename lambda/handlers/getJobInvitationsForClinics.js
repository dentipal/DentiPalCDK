"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, ScanCommand, QueryCommand, GetItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

/* 🔽 Added CORS headers */
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",                         // change to your app domain if needed
  "Access-Control-Allow-Headers": "Content-Type,Authorization",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  // "Access-Control-Allow-Credentials": "true",               // uncomment if you need cookies/credentials and set a specific origin
};

/* 🔽 helper: fetch first_name/last_name by userSub from PROFESSIONAL_PROFILES_TABLE */
async function fetchProfessionalNameBySub(userSub) {
  try {
    if (!process.env.PROFESSIONAL_PROFILES_TABLE || !userSub) {
      return { first_name: "", last_name: "" };
    }

    // First, try direct GetItem with PK = userSub
    const getRes = await dynamodb.send(new GetItemCommand({
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      Key: { userSub: { S: userSub } },
      ProjectionExpression: "first_name, last_name",
    }));

    if (getRes.Item) {
      return {
        first_name: getRes.Item.first_name?.S || "",
        last_name: getRes.Item.last_name?.S || "",
      };
    }

    // Fallback to GSI named "userSub-index" (if your table uses it)
    const qRes = await dynamodb.send(new QueryCommand({
      TableName: process.env.PROFESSIONAL_PROFILES_TABLE,
      IndexName: "userSub-index",
      KeyConditionExpression: "userSub = :u",
      ExpressionAttributeValues: { ":u": { S: userSub } },
      ProjectionExpression: "first_name, last_name",
      Limit: 1,
    }));

    const item = qRes.Items?.[0];
    if (item) {
      return {
        first_name: item.first_name?.S || "",
        last_name: item.last_name?.S || "",
      };
    }
  } catch (e) {
    console.warn("Name lookup in PROFESSIONAL_PROFILES_TABLE failed:", e);
  }
  return { first_name: "", last_name: "" };
}

const handler = async (event) => {
  try {
    /* 🔽 Handle preflight */
    if (event?.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers: CORS_HEADERS,
      };
    }

    // Log to confirm the environment variables are set correctly
    console.log('JOB_INVITATIONS_TABLE:', process.env.JOB_INVITATIONS_TABLE);
    console.log('JOB_POSTINGS_TABLE:', process.env.JOB_POSTINGS_TABLE);
    console.log('PROFESSIONAL_PROFILES_TABLE:', process.env.PROFESSIONAL_PROFILES_TABLE); // 🔽 added

    // Check if table names are set correctly
    if (!process.env.JOB_INVITATIONS_TABLE || !process.env.JOB_POSTINGS_TABLE) {
      return {
        statusCode: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, // 🔽 CORS added
        body: JSON.stringify({
          error: 'Table names are missing from the environment variables',
        }),
      };
    }

    // Extract clinicId from path parameters (proxy)
    const fullPath = event.pathParameters?.proxy; // Get the entire path
    const clinicId = fullPath ? fullPath.split('/')[1] : null;  // Extract clinicId after "/invitations/"

    console.log('Extracted clinicId from proxy path:', clinicId);  // Log clinicId

    if (!clinicId) {
      console.error('clinicId is missing in the path parameters');
      return {
        statusCode: 400,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, // 🔽 CORS added
        body: JSON.stringify({ error: "clinicId is required in the path" }),
      };
    }

    // Optional query parameters
    const queryParams = event.queryStringParameters || {};
    const invitationStatus = queryParams.status; // e.g., pending, accepted, declined
    const limit = queryParams.limit ? parseInt(queryParams.limit) : 50;

    console.log('Query parameters:', queryParams);

    // Scan Invitations Table based on clinicId
    const scanParams = {
      TableName: process.env.JOB_INVITATIONS_TABLE,
      FilterExpression: "clinicId = :clinicId" +
        (invitationStatus ? " AND invitationStatus = :status" : ""),
      ExpressionAttributeValues: {
        ":clinicId": { S: clinicId },
        ...(invitationStatus && { ":status": { S: invitationStatus } })
      },
      Limit: limit
    };

    console.log('ScanParams:', scanParams);

    const scanCommand = new ScanCommand(scanParams);
    const scanResponse = await dynamodb.send(scanCommand);

    console.log('Scan response:', scanResponse);

    const invitations = [];

    if (scanResponse.Items) {
      console.log(`Found ${scanResponse.Items.length} invitations`);

      for (const item of scanResponse.Items) {
        const invitation = {
          invitationId: item.invitationId?.S || '',
          jobId: item.jobId?.S || '',
          clinicId: item.clinicId?.S || '',
          professionalUserSub: item.professionalUserSub?.S || '',
          invitationStatus: item.invitationStatus?.S || 'pending',
          sentAt: item.sentAt?.S || '',
          updatedAt: item.updatedAt?.S || '',
        };

        // Optional fields
        if (item.message?.S) {
          invitation.message = item.message.S;
        }
        if (item.rateOffered?.N) {
          invitation.rateOffered = parseFloat(item.rateOffered.N);
        }
        if (item.validUntil?.S) {
          invitation.validUntil = item.validUntil.S;
        }

        // 🔽 fetch first_name / last_name from PROFESSIONAL_PROFILES_TABLE
        try {
          const { first_name, last_name } = await fetchProfessionalNameBySub(invitation.professionalUserSub);
          invitation.first_name = first_name;
          invitation.last_name = last_name;
        } catch (nameErr) {
          console.warn(`Failed to fetch professional name for ${invitation.professionalUserSub}:`, nameErr);
        }

        // Fetch job details based on jobId (using the jobId-index GSI)
        try {
          console.log(`Querying JOB_POSTINGS_TABLE with jobId: ${invitation.jobId}`); // Log the jobId being queried

          const jobCommand = new QueryCommand({
            TableName: process.env.JOB_POSTINGS_TABLE,
            IndexName: 'jobId-index', // Use the existing GSI jobId-index
            KeyConditionExpression: "jobId = :jobId",
            ExpressionAttributeValues: {
              ":jobId": { S: invitation.jobId }
            }
          });

          const jobResponse = await dynamodb.send(jobCommand);

          // Log the response of the job query
          console.log("Job Response:", jobResponse);

          if (jobResponse.Items && jobResponse.Items[0]) {
            const job = jobResponse.Items[0];
            invitation.jobTitle = job.professional_role?.S || 'Unknown Job Title';
            invitation.jobType = job.job_type?.S || 'Unknown';
            invitation.jobLocation = job.job_location?.S || 'Unknown Location';
            invitation.jobDescription = job.job_description?.S || 'No description available';
            invitation.jobHourlyRate = job.hourly_rate?.N ? parseFloat(job.hourly_rate.N) : null;
            invitation.jobSalaryMin = job.salary_min?.N ? parseFloat(job.salary_min.N) : null;
            invitation.jobSalaryMax = job.salary_max?.N ? parseFloat(job.salary_max.N) : null;
            invitation.dates = job.dates?.SS || [];
            invitation.startdate=job.start_date?.S || "";
            invitation.startTime=job.start_time?.S || '';
            invitation.endTime=job.end_time?.S || '';
            invitation.date=job.date?.S || '';
            invitation.jobHours = job.hours?.N ? parseFloat(job.hours.N) : null;
            invitation.jobHoursPerDay = job.hours_per_day?.N ? parseFloat(job.hours_per_day.N) : null;
            invitation.jobEmploymentType = job.employment_type?.S || 'Unknown Employment Type';
            invitation.jobBenefits = job.benefits?.SS || [];
            invitation.jobRequirements = job.requirements?.SS || [];
            invitation.jobMealBreak = job.meal_break?.BOOL || false;
            invitation.jobLocation = {
              addressLine1: job.addressLine1?.S || '',
              addressLine2: job.addressLine2?.S || '',
              addressLine3: job.addressLine3?.S || '',
              city: job.city?.S || '',
              state: job.state?.S || '',
              zipCode: job.pincode?.S || ''
            };
            invitation.contactInfo = {
              email: job.contact_email?.S || '',
              phone: job.contact_phone?.S || ''
            };
          } else {
            console.warn(`No job found for JobId: ${invitation.jobId}`);
          }
        } catch (jobError) {
          console.warn(`Failed to fetch job details for JobId: ${invitation.jobId}:`, jobError);
          // Continue without job details
        }

        invitations.push(invitation);
      }
    } else {
      console.log('No invitations found for the given clinicId');
    }

    // Sort by sentAt (descending)
    invitations.sort((a, b) => new Date(b.sentAt).getTime() - new Date(a.sentAt).getTime());

    return {
      statusCode: 200,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, // 🔽 CORS added
      body: JSON.stringify({
        message: "Invitations fetched successfully.",
        invitations,
        totalCount: invitations.length,
        filters: {
          status: invitationStatus || 'all',
          limit
        }
      })
    };

  } catch (error) {
    console.error("Error fetching invitations:", error);
    return {
      statusCode: 500,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }, // 🔽 CORS added
      body: JSON.stringify({
        error: "Failed to retrieve invitations.",
        details: error.message
      })
    };
  }
};

exports.handler = handler;
