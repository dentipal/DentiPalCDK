// Imports from AWS SDK
import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  DynamoDBClientConfig,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

// Imports for AWS Lambda types
import {
  APIGatewayProxyEventV2,
  APIGatewayProxyResultV2,
} from "aws-lambda";

// External utilities
import { extractUserFromBearerToken } from "./utils";
import { v4 as uuidv4 } from "uuid";

// --- Type Definitions ---
interface InvitationResponseData {
  response: "accepted" | "declined" | "negotiating";
  message?: string;
  proposedHourlyRate?: number;
  proposedSalaryMin?: number;
  proposedSalaryMax?: number;
  availabilityNotes?: string;
  counterProposalMessage?: string;
}

interface InvitationItem {
  invitationId?: AttributeValue;
  professionalUserSub?: AttributeValue;
  jobId?: AttributeValue;
  clinicUserSub?: AttributeValue;
  clinicId?: AttributeValue;
  invitationStatus?: AttributeValue;
  [key: string]: AttributeValue | undefined;
}

interface JobItem {
  job_type?: AttributeValue;
  status?: AttributeValue;
  clinicId?: AttributeValue;
  jobId?: AttributeValue;
  [key: string]: AttributeValue | undefined;
}

type HandlerResponse = APIGatewayProxyResultV2;

// --- Constants and Initialization ---
const REGION: string = process.env.REGION!;
const JOB_INVITATIONS_TABLE: string = process.env.JOB_INVITATIONS_TABLE!;
const JOB_POSTINGS_TABLE: string = process.env.JOB_POSTINGS_TABLE!;
const JOB_APPLICATIONS_TABLE: string = process.env.JOB_APPLICATIONS_TABLE!;
const JOB_NEGOTIATIONS_TABLE: string = process.env.JOB_NEGOTIATIONS_TABLE!;

const dynamodb = new DynamoDBClient({ region: REGION } as DynamoDBClientConfig);

import { CORS_HEADERS } from "./corsHeaders";

const VALID_RESPONSES: ReadonlyArray<InvitationResponseData['response']> = [
  "accepted",
  "declined",
  "negotiating"
];

// --- Main Handler Function ---
export const handler = async (
  event: APIGatewayProxyEventV2
): Promise<HandlerResponse> => {
  
  // LOG: Entry
  console.log("--- HANDLER STARTED ---");

  // Calculate method and path BEFORE logging to avoid "undefined undefined"
  const method = (event.requestContext as any).http?.method || (event as any).httpMethod || "POST";
  const rawPath = event.rawPath || (event as any).path || "";

  console.log("Event Method/Path:", method, rawPath);

  // Handle CORS preflight
  if (method === "OPTIONS") {
    return { statusCode: 200, headers: CORS_HEADERS, body: "" };
  }

  try {
    // --- STEP 1: AUTHENTICATION ---
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    const userInfo = extractUserFromBearerToken(authHeader);
    const userSub = userInfo.sub;
    
    console.log("1. Authenticated User:", userSub);

    // 2. Extract invitationId from path
    const match = rawPath.match(/\/invitations\/([^/]+)\/response/);
    const invitationId: string | undefined = match?.[1];
    
    console.log("2. Extracted Invitation ID:", invitationId);

    if (!invitationId) {
      console.warn("Error: Missing invitationId in path");
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "invitationId is required in path" }),
      };
    }

    // 3. Parse and Validate Request Body
    const responseData: InvitationResponseData = JSON.parse(event.body || "{}");
    
    console.log("3. Request Body Parsed:", JSON.stringify(responseData, null, 2));

    if (!responseData.response || !VALID_RESPONSES.includes(responseData.response)) {
      return {
        statusCode: 400,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: `Invalid or missing 'response' field. Valid options: ${VALID_RESPONSES.join(", ")}`
        }),
      };
    }

    // 4. Fetch Invitation
    console.log("4. Fetching Invitation from DynamoDB...");
    const invitationQuery = await dynamodb.send(
      new QueryCommand({
        TableName: JOB_INVITATIONS_TABLE,
        IndexName: "invitationId-index",
        KeyConditionExpression: "invitationId = :invId",
        ExpressionAttributeValues: {
          ":invId": { S: invitationId },
        },
      })
    );

    const invitation: InvitationItem | undefined = invitationQuery.Items?.[0];

    if (invitation) {
      console.log("   Invitation Found:", JSON.stringify(invitation, null, 2));
    } else {
      console.warn("   Invitation NOT FOUND for ID:", invitationId);
    }

    if (!invitation) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Invitation not found" }),
      };
    }

    const professionalUserSub: string | undefined = invitation.professionalUserSub?.S;
    const jobId: string | undefined = invitation.jobId?.S;
    const clinicUserSub: string | undefined = invitation.clinicUserSub?.S;
    const clinicId: string | undefined = invitation.clinicId?.S;

    // 5. Authorization & State Check
    if (professionalUserSub !== userSub) {
      console.warn(`Auth Error: Token User (${userSub}) !== Invitation User (${professionalUserSub})`);
      return {
        statusCode: 403,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "You can only respond to your own invitations" }),
      };
    }

    if (!jobId || !clinicUserSub || !clinicId) {
      console.error("Data Integrity Error: Missing FKs in invitation item");
      return {
        statusCode: 500,
        headers: CORS_HEADERS,
        body: JSON.stringify({
          error: "Invalid invitation data - missing jobId, clinicUserSub, or clinicId"
        }),
      };
    }

    const currentStatus = invitation.invitationStatus?.S;
    console.log("   Current Invitation Status:", currentStatus);
    
    if (currentStatus === "accepted" || currentStatus === "declined") {
      return {
        statusCode: 409,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: `Invitation has already been ${currentStatus}` }),
      };
    }

    // 6. Fetch Job Details
    console.log(`5. Fetching Job Details for JobID: ${jobId}`);
    
    // ✅ CRITICAL FIX: Updated IndexName to match your CDK Stack ('jobId-index-1')
    const jobQuery = await dynamodb.send(
      new QueryCommand({
        TableName: JOB_POSTINGS_TABLE,
        IndexName: "jobId-index-1", // <--- UPDATED THIS LINE
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
      })
    );

    const job: JobItem | undefined = jobQuery.Items?.[0];
    
    if(job) {
        console.log("   Job Found:", JSON.stringify(job, null, 2));
    } else {
        console.warn("   Job NOT FOUND");
    }

    if (!job) {
      return {
        statusCode: 404,
        headers: CORS_HEADERS,
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    // --- 7. Process Response and Conditional Logic ---
    const timestamp: string = new Date().toISOString();
    let applicationId: string | null = null;
    const jobType: string | undefined = job.job_type?.S;

    console.log(`6. Processing Logic Branch: ${responseData.response}`);

    if (responseData.response === "accepted") {
      // A. Accepted Logic
      applicationId = uuidv4();

      console.log(`   Action: Creating Application (Accepted). ID: ${applicationId}`);

      // Create Application Item
      await dynamodb.send(
        new PutItemCommand({
          TableName: JOB_APPLICATIONS_TABLE,
          Item: {
            applicationId: { S: applicationId },
            jobId: { S: jobId },
            professionalUserSub: { S: userSub },
            clinicUserSub: { S: clinicUserSub },
            clinicId: { S: clinicId },
            applicationStatus: { S: "accepted" },
            appliedAt: { S: timestamp },
            updatedAt: { S: timestamp },
            applicationMessage: {
              S: responseData.message || "Application submitted via invitation"
            },
            fromInvitation: { BOOL: true },
            invitationResponseDate: { S: timestamp },
          },
        })
      );
      console.log("   -> Application Created.");

      // Check Job Status for Update
      const jobStatus = job.status?.S;
      console.log(`   Job Status Check: Current status is '${jobStatus}'`);

      if (jobStatus === "open" || jobStatus === "active") {
        try {
          const jobClinicId = job.clinicId?.S || clinicId;
          const jobJobId = job.jobId?.S || jobId;

          console.log("   Action: Updating Job Status to 'scheduled'");
          console.log("   -> Using Keys for Update:", { clinicId: jobClinicId, jobId: jobJobId });

          await dynamodb.send(
            new UpdateItemCommand({
              TableName: JOB_POSTINGS_TABLE,
              Key: {
                clinicId: { S: jobClinicId },
                jobId: { S: jobJobId },
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
          console.log("   -> Job Updated Successfully.");
        } catch (updateError: any) {
          console.error("   -> FAILED to update job posting status:", updateError);
        }
      }
    } else if (responseData.response === "negotiating") {
      // B. Negotiating Logic
      console.log("   Action: Starting Negotiation Validation...");
      
      if (jobType === "permanent") {
        if (
          responseData.proposedSalaryMin == null ||
          responseData.proposedSalaryMax == null
        ) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedSalaryMin and proposedSalaryMax are required for permanent job negotiations"
            }),
          };
        }
        if (
          Number(responseData.proposedSalaryMax) <
          Number(responseData.proposedSalaryMin)
        ) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedSalaryMax must be greater than proposedSalaryMin"
            }),
          };
        }
      } else {
        if (responseData.proposedHourlyRate == null) {
          return {
            statusCode: 400,
            headers: CORS_HEADERS,
            body: JSON.stringify({
              error: "proposedHourlyRate is required for hourly job negotiations"
            }),
          };
        }
      }

      applicationId = uuidv4();
      
      // Create Application Item
      const applicationItem: any = {
        applicationId: { S: applicationId },
        jobId: { S: jobId },
        professionalUserSub: { S: userSub },
        clinicUserSub: { S: clinicUserSub },
        clinicId: { S: clinicId },
        applicationStatus: { S: "negotiating" },
        appliedAt: { S: timestamp },
        updatedAt: { S: timestamp },
        applicationMessage: {
          S: responseData.message || "Application submitted with counter-proposal"
        },
        fromInvitation: { BOOL: true },
        invitationResponseDate: { S: timestamp },
      };

      if (responseData.availabilityNotes) {
        applicationItem.availabilityNotes = { S: responseData.availabilityNotes };
      }

      await dynamodb.send(
        new PutItemCommand({
          TableName: JOB_APPLICATIONS_TABLE,
          Item: applicationItem,
        })
      );

      // Create Negotiation Item
      const negotiationId = uuidv4();
      
      const negotiationItem: any = {
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
        message: {
          S: responseData.counterProposalMessage || "Counter-proposal submitted"
        },
      };

      if (jobType === "permanent") {
        negotiationItem.proposedSalaryMin = {
          N: String(responseData.proposedSalaryMin)
        };
        negotiationItem.proposedSalaryMax = {
          N: String(responseData.proposedSalaryMax)
        };
      } else {
        negotiationItem.proposedHourlyRate = {
          N: String(responseData.proposedHourlyRate)
        };
      }

      await dynamodb.send(
        new PutItemCommand({
          TableName: JOB_NEGOTIATIONS_TABLE,
          Item: negotiationItem,
        })
      );
      console.log("   -> Application and Negotiation items created.");
    }

    // 8. Update Invitation Status
    console.log(`7. Final Step: Updating Invitation Status to '${responseData.response}'`);
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: JOB_INVITATIONS_TABLE,
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
    console.log("   -> Invitation Updated.");

    // 9. Success Response
    console.log("--- HANDLER FINISHED SUCCESS ---");
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
        jobType: jobType,
        nextSteps:
          responseData.response === "accepted"
            ? "Job has been scheduled. Wait for clinic confirmation."
            : responseData.response === "negotiating"
            ? "Negotiation started. Clinic will review your proposal."
            : "Invitation declined. Thank you for your response.",
      }),
    };
  } catch (error: any) {
    console.error("!!! CRITICAL LAMBDA ERROR !!!");
    console.error("Error Message:", error.message);
    console.error("Full Error Stack:", error);

    // Auth error handling
    if (
      error.message === "Authorization header missing" ||
      error.message?.startsWith("Invalid authorization header") ||
      error.message === "Invalid access token format" ||
      error.message === "Failed to decode access token" ||
      error.message === "User sub not found in token claims"
    ) {
      return {
        statusCode: 401,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
            "Access-Control-Allow-Headers": "Content-Type,Authorization",
        },
        body: JSON.stringify({
          error: "Unauthorized",
          details: error.message,
        }),
      };
    }

    // General error handling
    return {
      statusCode: 500,
      headers: {
        "Access-Control-Allow-Origin": "*", 
        "Access-Control-Allow-Methods": "OPTIONS,POST,GET,PUT,DELETE",
        "Access-Control-Allow-Headers": "Content-Type,Authorization",
      },
      body: JSON.stringify({ 
          error: "Internal Server Error",
          details: error.message || "Unknown error occurred" 
      }),
    };
  }
};