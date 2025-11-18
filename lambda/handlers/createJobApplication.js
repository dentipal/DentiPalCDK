"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  GetItemCommand
} = require("@aws-sdk/client-dynamodb");

const { v4: uuidv4 } = require("uuid");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const handler = async (event) => {
  try {
    console.log("Table name for Job Postings: DentiPal-JobPostings");
    console.log("Table name for Job Applications: DentiPal-JobApplications");
    console.log("Table name for Clinic Profiles: DentiPal-ClinicProfiles");
    console.log("Table name for Job Negotiations: DentiPal-JobNegotiations");

    const professionalUserSub = await validateToken(event);
    const applicationData = JSON.parse(event.body);
    console.log("Request body:", applicationData);

    if (!applicationData.jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Required field: jobId" }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*", // Allow all origins
          "Access-Control-Allow-Headers": "Content-Type", // Allow specific headers
        }
      };
    }

    // ✅ Fetch job posting using jobId-index GSI
    const jobQuery = new QueryCommand({
      TableName: "DentiPal-JobPostings",
      IndexName: "jobId-index",
      KeyConditionExpression: "jobId = :jobId",
      ExpressionAttributeValues: {
        ":jobId": { S: applicationData.jobId }
      }
    });

    const jobQueryResult = await dynamodb.send(jobQuery);
    if (!jobQueryResult.Items || jobQueryResult.Items.length === 0) {
      return {
        statusCode: 404,
        body: JSON.stringify({ error: "Job posting not found" }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      };
    }

    const jobItem = jobQueryResult.Items[0];
    const clinicId = jobItem.clinicId?.S;
    const jobStatus = jobItem.status?.S || 'active';

    if (!clinicId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: "Clinic ID not found in job posting" }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      };
    }

    if (jobStatus !== "active") {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: `Cannot apply to ${jobStatus} job posting` }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      };
    }

    // ✅ Check if application already exists
    const existingApplicationCommand = new QueryCommand({
      TableName: "DentiPal-JobApplications",
      KeyConditionExpression: "jobId = :jobId AND professionalUserSub = :professionalUserSub",
      ExpressionAttributeValues: {
        ":jobId": { S: applicationData.jobId },
        ":professionalUserSub": { S: professionalUserSub }
      }
    });

    const existingApplication = await dynamodb.send(existingApplicationCommand);
    if (existingApplication.Items && existingApplication.Items.length > 0) {
      return {
        statusCode: 409,
        body: JSON.stringify({ error: "You have already applied to this job" }),
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Headers": "Content-Type",
        }
      };
    }

    // ✅ Prepare application item
    const applicationId = uuidv4();
    const timestamp = new Date().toISOString();
    const applicationItem = {
      jobId: { S: applicationData.jobId },
      professionalUserSub: { S: professionalUserSub },
      applicationId: { S: applicationId },
      clinicId: { S: clinicId },
      applicationStatus: { S: applicationData.proposedRate ? "negotiating" : "pending" },  // Set applicationStatus to 'negotiating'
      appliedAt: { S: timestamp },
      updatedAt: { S: timestamp }
    };

    if (applicationData.message) {
      applicationItem.applicationMessage = { S: applicationData.message };
    }
    if (applicationData.proposedRate) {
      applicationItem.proposedRate = { N: applicationData.proposedRate.toString() };
    }
    if (applicationData.availability) {
      applicationItem.availability = { S: applicationData.availability };
    }
    if (applicationData.startDate) {
      applicationItem.startDate = { S: applicationData.startDate };
    }
    if (applicationData.notes) {
      applicationItem.notes = { S: applicationData.notes };
    }

    let negotiationId;
    if (applicationData.proposedRate) {
      negotiationId = uuidv4();
      applicationItem.negotiationId = { S: negotiationId };
    }

    console.log("Creating job application:", JSON.stringify(applicationItem));

    // ✅ Insert into JobApplications table
    await dynamodb.send(new PutItemCommand({
      TableName: "DentiPal-JobApplications",
      Item: applicationItem
    }));

    // ✅ Negotiating Logic - Handle if the response is "negotiating"
    if (applicationData.proposedRate) {
      // Create negotiation item
      const negotiationItem = {
        negotiationId: { S: negotiationId },
        jobId: { S: applicationData.jobId },
        applicationId: { S: applicationId }, 
        professionalUserSub: { S: professionalUserSub },
        clinicId: { S: clinicId },  // Clinic ID from job posting
        negotiationStatus: { S: 'pending' },  // Use 'negotiationStatus'
        proposedHourlyRate: { N: applicationData.proposedRate.toString() },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
        message: { S: applicationData.message || 'Negotiation initiated' }
      };

      // Save negotiation item to JobNegotiations table
      await dynamodb.send(new PutItemCommand({
        TableName: "DentiPal-JobNegotiations",
        Item: negotiationItem
      }));

      console.log("Job negotiation created:", JSON.stringify(negotiationItem));
    }

    // ✅ Fetch clinic info
    let clinicInfo = null;
    try {
      const clinicCommand = new GetItemCommand({
        TableName: "DentiPal-ClinicProfiles",
        Key: {
          clinicId: { S: clinicId }
        }
      });

      const clinicResponse = await dynamodb.send(clinicCommand);
      const clinic = clinicResponse.Item;

      if (clinic) {
        clinicInfo = {
          name: clinic.clinic_name?.S || "Unknown Clinic",
          city: clinic.city?.S || "",
          state: clinic.state?.S || "",
          practiceType: clinic.practice_type?.S || "",
          primaryPracticeArea: clinic.primary_practice_area?.S || "",
          contactName: `${clinic.primary_contact_first_name?.S || ""} ${clinic.primary_contact_last_name?.S || ""}`.trim()
        };
      }
    } catch (err) {
      console.warn("Failed to fetch clinic info:", err);
    }

    // ✅ Prepare job info
    const jobInfo = {
      title: jobItem.job_title?.S || `${jobItem.professional_role?.S || "Professional"} Position`,
      type: jobItem.job_type?.S || "unknown",
      role: jobItem.professional_role?.S || "",
      hourlyRate: jobItem.hourly_rate?.N ? parseFloat(jobItem.hourly_rate.N) : undefined,
      date: jobItem.date?.S,
      dates: jobItem.dates?.SS
    };

    // ✅ Final response
    return {
      statusCode: 201,
      body: JSON.stringify({
        message: "Job application submitted successfully",
        applicationId,
        jobId: applicationData.jobId,
        status: applicationData.proposedRate ? "negotiating" : "pending",  // Set the status to 'negotiating'
        appliedAt: timestamp,
        job: jobInfo,
        clinic: clinicInfo
      }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",  // Allow all origins
        "Access-Control-Allow-Headers": "Content-Type",  // Allow specific headers
      }
    };
  } catch (error) {
    console.error("Error creating job application:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Failed to submit job application. Please try again.",
        details: error.message
      }),
      headers: {
        "Content-Type": "application/json",
        "Access-Control-Allow-Origin": "*",  // Allow all origins
        "Access-Control-Allow-Headers": "Content-Type",  // Allow specific headers
      }
    };
  }
};

exports.handler = handler;