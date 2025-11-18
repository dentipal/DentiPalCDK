"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.handler = void 0;

const { DynamoDBClient, QueryCommand, PutItemCommand, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");
const { v4: uuidv4 } = require("uuid");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const handler = async (event) => {
  // Handle CORS preflight
  if (event?.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    const userSub = await validateToken(event);
    console.log("Authenticated userSub from token:", userSub);

    const path = event.path || "";
    const match = path.match(/\/invitations\/([^\/]+)\/response/);
    const invitationId = match?.[1];

    if (!invitationId) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "invitationId is required in path" }),
      };
    }

    const responseData = JSON.parse(event.body || "{}");

    if (!responseData.response) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "response is required (accepted, declined, or negotiating)" }),
      };
    }

    const validResponses = ["accepted", "declined", "negotiating"];
    if (!validResponses.includes(responseData.response)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Invalid response. Valid options: ${validResponses.join(", ")}` }),
      };
    }

    const invitationQuery = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.JOB_INVITATIONS_TABLE,
        IndexName: "invitationId-index",
        KeyConditionExpression: "invitationId = :invId",
        ExpressionAttributeValues: {
          ":invId": { S: invitationId },
        },
      })
    );

    const invitation = invitationQuery.Items?.[0];

    if (!invitation) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invitation not found" }),
      };
    }

    const professionalUserSub = invitation.professionalUserSub?.S;
    const jobId = invitation.jobId?.S;
    const clinicUserSub = invitation.clinicUserSub?.S;
    const clinicId = invitation.clinicId?.S; // Extract clinicId from the invitation

    if (professionalUserSub !== userSub) {
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "You can only respond to your own invitations" }),
      };
    }

    if (!jobId || !clinicUserSub || !clinicId) {
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invalid invitation data - missing jobId, clinicUserSub, or clinicId" }),
      };
    }

    if (invitation.invitationStatus?.S === "accepted" || invitation.invitationStatus?.S === "declined") {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Invitation has already been ${invitation.invitationStatus.S}` }),
      };
    }

    // Fetch job by jobId (via its GSI)
    const jobQuery = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        IndexName: "jobId-index", // replace if your GSI name differs
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
      })
    );

    const job = jobQuery.Items?.[0];

    if (!job) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    const timestamp = new Date().toISOString();
    let applicationId = null;

    if (responseData.response === "accepted") {
      applicationId = uuidv4();

      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.JOB_APPLICATIONS_TABLE,
          Item: {
            applicationId: { S: applicationId },
            jobId: { S: jobId },
            professionalUserSub: { S: userSub },
            clinicUserSub: { S: clinicUserSub },
            clinicId: { S: clinicId }, // Store clinicId here
            applicationStatus: { S: "accepted" },
            appliedAt: { S: timestamp },
            updatedAt: { S: timestamp },
            applicationMessage: { S: responseData.message || "Application submitted via invitation" },
            fromInvitation: { BOOL: true },
            invitationResponseDate: { S: timestamp },
          },
        })
      );

      if (job.status?.S === "open") {
        await dynamodb.send(
          new UpdateItemCommand({
            TableName: process.env.JOB_INVITATIONS_TABLE,
            Key: {
              jobId: { S: jobId },
              professionalUserSub: { S: userSub },
            },
            UpdateExpression:
              "SET #status = :status, #acceptedProfessional = :professional, #updatedAt = :updatedAt",
            ExpressionAttributeNames: {
              "#status": "status",
              "#acceptedProfessional": "acceptedProfessionalUserSub",
              "#updatedAt": "updatedAt",
            },
            ExpressionAttributeValues: {
              ":status": { S: "scheduled" },
              ":professional": { S: userSub },
              ":updatedAt": { S: timestamp },
            },
          })
        );
      }
    } else if (responseData.response === "negotiating") {
      const jobType = job.job_type?.S;

      if (jobType === "permanent") {
        if (!responseData.proposedSalaryMin || !responseData.proposedSalaryMax) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedSalaryMin and proposedSalaryMax are required for permanent job negotiations",
            }),
          };
        }
        if (Number(responseData.proposedSalaryMax) < Number(responseData.proposedSalaryMin)) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedSalaryMax must be greater than proposedSalaryMin",
            }),
          };
        }
      } else {
        if (responseData.proposedHourlyRate == null) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedHourlyRate is required for hourly job negotiations",
            }),
          };
        }
      }

      applicationId = uuidv4();

      const applicationItem = {
        applicationId: { S: applicationId },
        jobId: { S: jobId },
        professionalUserSub: { S: userSub },
        clinicUserSub: { S: clinicUserSub },
        clinicId: { S: clinicId }, // Store clinicId here in negotiation as well
        applicationStatus: { S: "negotiating" },
        appliedAt: { S: timestamp },
        updatedAt: { S: timestamp },
        applicationMessage: { S: responseData.message || "Application submitted with counter-proposal" },
        fromInvitation: { BOOL: true },
        invitationResponseDate: { S: timestamp },
      };

      if (responseData.availabilityNotes) {
        applicationItem.availabilityNotes = { S: responseData.availabilityNotes };
      }

      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.JOB_APPLICATIONS_TABLE,
          Item: applicationItem,
        })
      );

      const negotiationId = uuidv4();

      const negotiationItem = {
        applicationId: { S: applicationId },
        negotiationId: { S: negotiationId },
        jobId: { S: jobId },
        fromType: { S: "professional" },
        fromUserSub: { S: userSub },
        toUserSub: { S: clinicUserSub },
        clinicId: { S: clinicId },
        negotiationStatus: { S: "pending" },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
        message: { S: responseData.counterProposalMessage || "Counter-proposal submitted" },
      };

      if (jobType === "permanent") {
        negotiationItem.proposedSalaryMin = { N: String(responseData.proposedSalaryMin) };
        negotiationItem.proposedSalaryMax = { N: String(responseData.proposedSalaryMax) };
      } else {
        negotiationItem.proposedHourlyRate = { N: String(responseData.proposedHourlyRate) };
      }

      await dynamodb.send(
        new PutItemCommand({
          TableName: process.env.JOB_NEGOTIATIONS_TABLE,
          Item: negotiationItem,
        })
      );
    }

    // Mark invitation responded (accepted / negotiating / declined)
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.JOB_INVITATIONS_TABLE,
        Key: {
          jobId: { S: jobId },
          professionalUserSub: { S: professionalUserSub },
        },
        UpdateExpression:
          "SET #status = :status, #respondedAt = :respondedAt, #responseMessage = :message, #updatedAt = :updatedAt",
        ExpressionAttributeNames: {
          "#status": "invitationStatus",
          "#respondedAt": "respondedAt",
          "#responseMessage": "responseMessage",
          "#updatedAt": "updatedAt",
        },
        ExpressionAttributeValues: {
          ":status": { S: responseData.response },
          ":respondedAt": { S: timestamp },
          ":message": { S: responseData.message || "" },
          ":updatedAt": { S: timestamp },
        },
      })
    );

    return {
      statusCode: 200,
      headers: CORS_HEADERS,
      body: JSON.stringify({
        message: `Invitation ${responseData.response} successfully`,
        invitationId,
        jobId,
        response: responseData.response,
        applicationId,
        respondedAt: timestamp,
        jobType: job.job_type?.S,
        nextSteps:
          responseData.response === "accepted"
            ? "Job has been scheduled. Wait for clinic confirmation."
            : responseData.response === "negotiating"
            ? "Negotiation started. Clinic will review your proposal."
            : "Invitation declined. Thank you for your response.",
      }),
    };
  } catch (error) {
    console.error("Error responding to invitation:", error);
    return {
      statusCode: 500,
      headers: CORS_HEADERS,
      body: JSON.stringify({ error: error.message }),
    };
  }
};

exports.handler = handler;
