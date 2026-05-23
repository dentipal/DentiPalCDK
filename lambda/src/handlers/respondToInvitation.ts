// Imports from AWS SDK
import {
  DynamoDBClient,
  QueryCommand,
  PutItemCommand,
  UpdateItemCommand,
  DynamoDBClientConfig,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";

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
const eb = new EventBridgeClient({ region: REGION });

import { corsHeaders } from "./corsHeaders";

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
    return { statusCode: 200, headers: corsHeaders(event), body: "" };
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
        headers: corsHeaders(event),
        body: JSON.stringify({ error: "invitationId is required in path" }),
      };
    }

    // 3. Parse and Validate Request Body
    const responseData: InvitationResponseData = JSON.parse(event.body || "{}");
    
    console.log("3. Request Body Parsed:", JSON.stringify(responseData, null, 2));

    if (!responseData.response || !VALID_RESPONSES.includes(responseData.response)) {
      return {
        statusCode: 400,
        headers: corsHeaders(event),
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
        headers: corsHeaders(event),
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
        headers: corsHeaders(event),
        body: JSON.stringify({ error: "You can only respond to your own invitations" }),
      };
    }

    if (!jobId || !clinicUserSub || !clinicId) {
      console.error("Data Integrity Error: Missing FKs in invitation item");
      return {
        statusCode: 500,
        headers: corsHeaders(event),
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
        headers: corsHeaders(event),
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
        headers: corsHeaders(event),
        body: JSON.stringify({ error: "Job not found" }),
      };
    }

    // --- 7. Process Response and Conditional Logic ---
    const timestamp: string = new Date().toISOString();
    let applicationId: string | null = null;
    let negotiationId: string | null = null;
    const jobType: string | undefined = job.job_type?.S;
    // Resolve pay type the same way createJobApplication.ts does (line 349)
    // so the invite-negotiate flow stores the exact same payType the open-jobs
    // negotiate flow stores. The UI uses this to label rates correctly.
    const jobPayType: string =
      job.pay_type?.S || job.payType?.S || "per_hour";

    console.log(`6. Processing Logic Branch: ${responseData.response}`);

    if (responseData.response === "accepted") {
      // A. Accepted Logic — direct-schedule flow.
      //
      // When a pro accepts an invitation we treat it as an immediate hire and
      // skip the clinic's "Action Needed" confirmation step. Mirrors
      // acceptProf.ts so the resulting state is identical to a clinic-side
      // accept:
      //   1. Atomically claim a position on the JobPostings row (capacity
      //      check). Two concurrent accepts on the last open seat cannot
      //      both win — the loser gets a clean 409.
      //   2. Reuse the pro's existing non-rejected application if one exists
      //      (cold-apply → invite, etc.), otherwise create a fresh one.
      //      Either way the row ends in applicationStatus = "scheduled".
      //   3. acceptedRate is sourced from the job posting (no negotiation
      //      occurred on this path; the pro accepted the invite terms).
      //   4. When the hire fills the last position, flip the job to
      //      "filled" and auto-reject any remaining pending / negotiating
      //      applicants — best-effort, same posture as acceptProf step 9.
      //   5. Publish both `invite-accepted` (existing: notifies the clinic
      //      team + opens the inbox conversation) and `shift-scheduled`
      //      (notifies the pro and posts the "Shift Scheduled" confirmation
      //      into the same inbox thread).
      const clinicUserSubFromJob = job.clinicUserSub?.S;
      if (!clinicUserSubFromJob) {
        return {
          statusCode: 500,
          headers: corsHeaders(event),
          body: JSON.stringify({
            error: "Job posting is missing clinicUserSub; cannot claim a position.",
          }),
        };
      }

      // 7.A.1 — Atomically claim a position. Legacy rows without
      // positionsFilled/positionsRequired are treated as 1 required / 0 filled
      // (matches the prior "first hire fills the job" behavior).
      let positionsFilledAfter: number | null = null;
      let positionsRequiredAfter: number | null = null;
      try {
        const incrRes = await dynamodb.send(
          new UpdateItemCommand({
            TableName: JOB_POSTINGS_TABLE,
            Key: {
              clinicUserSub: { S: clinicUserSubFromJob },
              jobId: { S: jobId },
            },
            UpdateExpression:
              "SET positionsFilled = if_not_exists(positionsFilled, :zero) + :one, " +
              "positionsRequired = if_not_exists(positionsRequired, :one), " +
              "updatedAt = :now",
            ConditionExpression:
              "attribute_not_exists(positionsFilled) OR positionsFilled < positionsRequired",
            ExpressionAttributeValues: {
              ":zero": { N: "0" },
              ":one": { N: "1" },
              ":now": { S: timestamp },
            },
            ReturnValues: "ALL_NEW",
          })
        );
        const pf = incrRes.Attributes?.positionsFilled?.N;
        const pr = incrRes.Attributes?.positionsRequired?.N;
        positionsFilledAfter = pf ? Number(pf) : null;
        positionsRequiredAfter = pr ? Number(pr) : null;
      } catch (capErr: any) {
        if (capErr?.name === "ConditionalCheckFailedException") {
          return {
            statusCode: 409,
            headers: corsHeaders(event),
            body: JSON.stringify({
              error: "JobAlreadyFilled",
              message: "All positions for this job have already been filled.",
            }),
          };
        }
        throw capErr;
      }

      // 7.A.2 — Resolve accepted rate from the job posting. No negotiation
      // lookup needed: the pro accepted the original invite terms as-is.
      const rateNum =
        (job.rate?.N && Number(job.rate.N)) ||
        (job.hourlyRate?.N && Number(job.hourlyRate.N)) ||
        (job.proposedRate?.N && Number(job.proposedRate.N)) ||
        null;
      const acceptedRate: number | null =
        rateNum != null && Number.isFinite(rateNum) && rateNum > 0 ? rateNum : null;

      // 7.A.3 — Reuse an existing non-rejected application if one exists
      // (e.g. the pro had cold-applied for this job before being invited);
      // otherwise create a fresh one. Either way the row ends in
      // applicationStatus = "scheduled".
      const existingApps = await dynamodb.send(
        new QueryCommand({
          TableName: JOB_APPLICATIONS_TABLE,
          KeyConditionExpression: "jobId = :jobId AND professionalUserSub = :userSub",
          ExpressionAttributeValues: {
            ":jobId": { S: jobId },
            ":userSub": { S: userSub },
          },
        })
      );
      const existingApp = existingApps.Items?.find(
        (item) => (item.applicationStatus?.S || "").toLowerCase() !== "rejected"
      );

      if (existingApp) {
        applicationId = existingApp.applicationId?.S || null;
        const updateExprParts: string[] = [
          "applicationStatus = :status",
          "updatedAt = :now",
          "fromInvitation = :fromInv",
          "invitationResponseDate = :now",
          "statusHistory = list_append(if_not_exists(statusHistory, :empty), :entry)",
        ];
        const exprVals: { [key: string]: AttributeValue } = {
          ":status": { S: "scheduled" },
          ":now": { S: timestamp },
          ":empty": { L: [] },
          ":fromInv": { BOOL: true },
          ":entry": {
            L: [
              {
                M: {
                  status: { S: "scheduled" },
                  at: { S: timestamp },
                  actorId: { S: userSub },
                  actorRole: { S: "professional" },
                  reason: { S: "invitation_accepted" },
                },
              },
            ],
          },
        };
        if (acceptedRate != null) {
          updateExprParts.push("acceptedRate = :acceptedRate");
          exprVals[":acceptedRate"] = { N: String(acceptedRate) };
        }
        await dynamodb.send(
          new UpdateItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Key: {
              jobId: { S: jobId },
              professionalUserSub: { S: userSub },
            },
            UpdateExpression: "SET " + updateExprParts.join(", "),
            ExpressionAttributeValues: exprVals,
          })
        );
        console.log(`   Existing application updated to scheduled. ID: ${applicationId}`);
      } else {
        applicationId = uuidv4();
        const applicationItem: { [key: string]: AttributeValue } = {
          applicationId: { S: applicationId },
          jobId: { S: jobId },
          professionalUserSub: { S: userSub },
          clinicUserSub: { S: clinicUserSub },
          clinicId: { S: clinicId },
          applicationStatus: { S: "scheduled" },
          appliedAt: { S: timestamp },
          updatedAt: { S: timestamp },
          applicationMessage: { S: responseData.message || "" },
          fromInvitation: { BOOL: true },
          invitationResponseDate: { S: timestamp },
          // Seed the audit trail directly at "scheduled" since the invite
          // acceptance IS the hire on this path.
          statusHistory: {
            L: [
              {
                M: {
                  status: { S: "scheduled" },
                  at: { S: timestamp },
                  actorId: { S: userSub },
                  actorRole: { S: "professional" },
                  reason: { S: "invitation_accepted" },
                },
              },
            ],
          },
        };
        if (acceptedRate != null) {
          applicationItem.acceptedRate = { N: String(acceptedRate) };
        }
        await dynamodb.send(
          new PutItemCommand({
            TableName: JOB_APPLICATIONS_TABLE,
            Item: applicationItem,
          })
        );
        console.log(`   Action: Created Application (Scheduled). ID: ${applicationId}`);
      }

      // 7.A.4 — If this hire filled the last position, flip the job posting
      // to "filled" and auto-reject any remaining pending / negotiating
      // applicants so they leave the clinic's Action Needed list. Best-effort
      // — failures here don't unwind the successful hire.
      const positionsAreFilled =
        positionsFilledAfter != null &&
        positionsRequiredAfter != null &&
        positionsFilledAfter >= positionsRequiredAfter;

      if (positionsAreFilled) {
        try {
          await dynamodb.send(
            new UpdateItemCommand({
              TableName: JOB_POSTINGS_TABLE,
              Key: {
                clinicUserSub: { S: clinicUserSubFromJob },
                jobId: { S: jobId },
              },
              UpdateExpression: "SET #s = :filled, updatedAt = :now",
              ExpressionAttributeNames: { "#s": "status" },
              ExpressionAttributeValues: {
                ":filled": { S: "filled" },
                ":now": { S: timestamp },
              },
            })
          );
        } catch (markErr: any) {
          console.warn(
            "[respondToInvitation] Failed to mark job posting as filled (non-fatal):",
            markErr?.message
          );
        }

        try {
          const remainingRes = await dynamodb.send(
            new QueryCommand({
              TableName: JOB_APPLICATIONS_TABLE,
              KeyConditionExpression: "jobId = :jid",
              FilterExpression:
                "(applicationStatus = :pending OR applicationStatus = :negotiating) AND professionalUserSub <> :hired",
              ExpressionAttributeValues: {
                ":jid": { S: jobId },
                ":pending": { S: "pending" },
                ":negotiating": { S: "negotiating" },
                ":hired": { S: userSub },
              },
            })
          );

          await Promise.allSettled(
            (remainingRes.Items || []).map(async (it) => {
              const otherSub = it.professionalUserSub?.S;
              if (!otherSub) return;
              try {
                await dynamodb.send(
                  new UpdateItemCommand({
                    TableName: JOB_APPLICATIONS_TABLE,
                    Key: {
                      jobId: { S: jobId },
                      professionalUserSub: { S: otherSub },
                    },
                    UpdateExpression:
                      "SET applicationStatus = :rejected, updatedAt = :now, " +
                      "statusHistory = list_append(if_not_exists(statusHistory, :empty), :entry)",
                    ConditionExpression:
                      "applicationStatus = :pending OR applicationStatus = :negotiating",
                    ExpressionAttributeValues: {
                      ":rejected": { S: "rejected" },
                      ":now": { S: timestamp },
                      ":pending": { S: "pending" },
                      ":negotiating": { S: "negotiating" },
                      ":empty": { L: [] },
                      ":entry": {
                        L: [
                          {
                            M: {
                              status: { S: "rejected" },
                              at: { S: timestamp },
                              actorId: { S: "system" },
                              actorRole: { S: "system" },
                              reason: { S: "job_filled" },
                            },
                          },
                        ],
                      },
                    },
                  })
                );
              } catch (rejErr: any) {
                if (rejErr?.name !== "ConditionalCheckFailedException") {
                  console.warn(
                    "[respondToInvitation] Auto-reject failed (non-fatal):",
                    { jobId, otherSub, error: rejErr?.message }
                  );
                }
              }
            })
          );
        } catch (sweepErr: any) {
          console.warn(
            "[respondToInvitation] Auto-reject sweep failed (non-fatal):",
            sweepErr?.message
          );
        }

        // 7.A.4.b — Auto-expire any still-outstanding invitations for this
        // job. The seat just claimed was the last one, so other invitees
        // can't take it anymore. Flip "sent" → "expired" so the pro UI hides
        // the Accept/Decline CTA and shows "Position filled". Best-effort:
        // failures are logged but never unwind the successful hire. Skips
        // the just-hired pro's own invitation row (their respondToInvitation
        // update at step 8 flips it to "accepted").
        try {
          const pendingInvitesRes = await dynamodb.send(
            new QueryCommand({
              TableName: JOB_INVITATIONS_TABLE,
              KeyConditionExpression: "jobId = :jid",
              FilterExpression:
                "(attribute_not_exists(invitationStatus) OR invitationStatus = :sent) " +
                "AND professionalUserSub <> :hired",
              ExpressionAttributeValues: {
                ":jid": { S: jobId },
                ":sent": { S: "sent" },
                ":hired": { S: userSub },
              },
              ProjectionExpression: "jobId, professionalUserSub",
            })
          );

          await Promise.allSettled(
            (pendingInvitesRes.Items || []).map(async (it) => {
              const inviteeSub = it.professionalUserSub?.S;
              if (!inviteeSub) return;
              try {
                await dynamodb.send(
                  new UpdateItemCommand({
                    TableName: JOB_INVITATIONS_TABLE,
                    Key: {
                      jobId: { S: jobId },
                      professionalUserSub: { S: inviteeSub },
                    },
                    UpdateExpression:
                      "SET invitationStatus = :expired, updatedAt = :now, expiredAt = :now, expiredReason = :reason",
                    // Idempotent: leave alone any invite that meanwhile
                    // transitioned to accepted/declined/negotiating.
                    ConditionExpression:
                      "attribute_not_exists(invitationStatus) OR invitationStatus = :sent",
                    ExpressionAttributeValues: {
                      ":expired": { S: "expired" },
                      ":sent": { S: "sent" },
                      ":now": { S: timestamp },
                      ":reason": { S: "job_filled" },
                    },
                  })
                );
              } catch (expErr: any) {
                if (expErr?.name !== "ConditionalCheckFailedException") {
                  console.warn(
                    "[respondToInvitation] Invitation expire failed (non-fatal):",
                    { jobId, inviteeSub, error: expErr?.message }
                  );
                }
              }
            })
          );
        } catch (expSweepErr: any) {
          console.warn(
            "[respondToInvitation] Invitation-expire sweep failed (non-fatal):",
            expSweepErr?.message
          );
        }
      }

      // 7.A.5 — Publish EventBridge events. Build a shared shiftDetails
      // payload that matches what acceptProf.ts emits so the downstream
      // notification / email / inbox consumers render identically.
      const rawRole =
        job.role?.S ||
        job.professionalRole?.S ||
        job.professional_role?.S ||
        job.jobTitle?.S ||
        "Professional";
      const shiftRoleLabel =
        typeof rawRole === "string"
          ? rawRole
              .split("_")
              .map((w) => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w))
              .join(" ")
          : rawRole;
      const rawDate =
        job.date?.S || job.shiftDate?.S || job.start_date?.S || "TBD";
      let formattedDate = rawDate;
      try {
        const d = new Date(rawDate);
        if (!isNaN(d.getTime())) {
          formattedDate = d.toLocaleDateString("en-US", {
            weekday: "short",
            month: "short",
            day: "numeric",
            year: "numeric",
          });
        }
      } catch {
        // Leave formattedDate as the raw string if parsing fails.
      }
      const shiftRate =
        acceptedRate != null
          ? acceptedRate
          : job.rate?.N
          ? Number(job.rate.N)
          : job.hourlyRate?.N
          ? Number(job.hourlyRate.N)
          : 0;

      const shiftDetails = {
        date: formattedDate,
        role: shiftRoleLabel,
        rate: shiftRate,
        startTime: job.start_time?.S || job.startTime?.S || "",
        endTime: job.end_time?.S || job.endTime?.S || "",
        location: job.city?.S || job.fullAddress?.S || "",
        jobType: job.job_type?.S || jobType || "",
      };

      // invite-accepted: existing channel. Notifies the clinic team via the
      // bell + opens the inbox conversation with the "Invite Accepted!" line.
      // Kept as a hard requirement (rethrow on failure) to match the prior
      // posture — the clinic must have a way to communicate with the hired pro.
      try {
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: "denti-pal.api",
                DetailType: "ShiftEvent",
                Detail: JSON.stringify({
                  eventType: "invite-accepted",
                  actor: "professional",
                  clinicId,
                  professionalSub: userSub,
                  jobId,
                  shiftDetails,
                }),
              },
            ],
          })
        );
        console.log(
          "   -> EventBridge ShiftEvent (invite-accepted) published for inbox conversation."
        );
      } catch (ebError: any) {
        console.error(
          "   -> FAILED to publish invite-accepted event:",
          ebError.message
        );
        throw ebError;
      }

      // shift-scheduled: notifies the pro that they're scheduled and adds
      // the "Shift Scheduled! ✅" confirmation message into the same inbox
      // thread (same consumer as the clinic-side acceptProf flow). Best-effort
      // — pro can still see the scheduled row on their dashboard if this
      // notification publish hiccups.
      try {
        await eb.send(
          new PutEventsCommand({
            Entries: [
              {
                Source: "denti-pal.api",
                DetailType: "ShiftEvent",
                Detail: JSON.stringify({
                  eventType: "shift-scheduled",
                  clinicId,
                  professionalSub: userSub,
                  jobId,
                  shiftDetails,
                }),
              },
            ],
          })
        );
        console.log(
          "   -> EventBridge ShiftEvent (shift-scheduled) published for pro notification."
        );
      } catch (ebError: any) {
        console.warn(
          "[respondToInvitation] shift-scheduled publish failed (non-fatal):",
          ebError?.message
        );
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
            headers: corsHeaders(event),
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
            headers: corsHeaders(event),
            body: JSON.stringify({
              error: "proposedSalaryMax must be greater than proposedSalaryMin"
            }),
          };
        }
      } else {
        if (responseData.proposedHourlyRate == null) {
          return {
            statusCode: 400,
            headers: corsHeaders(event),
            body: JSON.stringify({
              error: "proposedHourlyRate is required for hourly job negotiations"
            }),
          };
        }
      }

      applicationId = uuidv4();
      negotiationId = uuidv4();

      // Create Application Item — mirror the shape written by
      // createJobApplication.ts (the open-jobs negotiate path) so the
      // professional's Pending tab and the clinic's NegotiationsOverviewPage
      // render this invite-originated negotiation identically to one started
      // from the open-jobs flow. Specifically:
      //   - proposedRate / proposedSalaryMin / proposedSalaryMax must be set
      //     on the APPLICATION (not just on the negotiation) — the Pending tab
      //     reads job.proposedRate to render the "Your Counter: $X/hr" badge.
      //   - negotiationId must be set on the application so ReCounterModal
      //     can find the negotiation to re-counter against.
      //   - payType must be persisted on both items so the UI labels are
      //     correct for per_transaction / percentage_of_revenue jobs.
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
        negotiationId: { S: negotiationId },
        payType: { S: jobPayType },
        fromInvitation: { BOOL: true },
        invitationResponseDate: { S: timestamp },
        // Seed the audit trail. Invite-originated negotiations enter at
        // "negotiating" rather than "pending" because the counter-proposal IS
        // the initial application state.
        statusHistory: {
          L: [
            {
              M: {
                status: { S: "negotiating" },
                at: { S: timestamp },
                actorId: { S: userSub },
                actorRole: { S: "professional" },
              },
            },
          ],
        },
      };

      if (jobType === "permanent") {
        applicationItem.proposedSalaryMin = {
          N: String(responseData.proposedSalaryMin)
        };
        applicationItem.proposedSalaryMax = {
          N: String(responseData.proposedSalaryMax)
        };
      } else {
        applicationItem.proposedRate = {
          N: String(responseData.proposedHourlyRate)
        };
      }

      if (responseData.availabilityNotes) {
        applicationItem.availabilityNotes = { S: responseData.availabilityNotes };
      }

      await dynamodb.send(
        new PutItemCommand({
          TableName: JOB_APPLICATIONS_TABLE,
          Item: applicationItem,
        })
      );

      // Create Negotiation Item — also mirrors createJobApplication.ts.
      // Field name notes:
      //   - The rate is stored as `proposedRate` (generic, all pay types) —
      //     NOT `proposedHourlyRate` (the legacy hourly-only name). The
      //     clinic-side NegotiationsTable and CounterOfferModal read the
      //     generic name.
      //   - `professionalUserSub` is stored alongside fromUserSub/toUserSub
      //     so getAllNegotiations-Prof.ts can query this negotiation by
      //     professional the same way it queries open-jobs negotiations.
      //   - fromType/fromUserSub/toUserSub stay for invite-origin metadata
      //     (used elsewhere to identify who initiated).
      const negotiationItem: any = {
        applicationId: { S: applicationId },
        negotiationId: { S: negotiationId },
        jobId: { S: jobId },
        professionalUserSub: { S: userSub },
        clinicId: { S: clinicId },
        fromType: { S: "professional" },
        fromUserSub: { S: userSub },
        toUserSub: { S: clinicUserSub },
        negotiationStatus: { S: "pending" },
        payType: { S: jobPayType },
        createdAt: { S: timestamp },
        updatedAt: { S: timestamp },
        message: {
          S: responseData.counterProposalMessage || responseData.message || "Counter-proposal submitted"
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
        negotiationItem.proposedRate = {
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

    // 8b. Publish EventBridge events for the in-app notification feed so the
    //     clinic team gets a bell + page entry when the pro declines or
    //     starts negotiating. `invite-accepted` is fired above (inside the
    //     accepted branch) because it also kicks off the inbox conversation.
    if (responseData.response === "declined" || responseData.response === "negotiating") {
      const inviteEventType = responseData.response === "declined" ? "invite-declined" : "invite-negotiating";
      try {
        await eb.send(new PutEventsCommand({
          Entries: [{
            Source: "denti-pal.api",
            DetailType: "ShiftEvent",
            Detail: JSON.stringify({
              eventType: inviteEventType,
              actor: "professional",
              clinicId,
              professionalSub: userSub,
              jobId,
              shiftDetails: {
                date: invitation.shiftDate?.S || invitation.date?.S || undefined,
                role: invitation.role?.S || invitation.professionalRole?.S || undefined,
                rate: invitation.rate?.N ? Number(invitation.rate.N) : undefined,
              },
            }),
          }],
        }));
        console.log(`   -> EventBridge ShiftEvent (${inviteEventType}) published.`);
      } catch (ebErr: any) {
        console.warn(`   -> ${inviteEventType} event publish failed (non-fatal):`, ebErr.message);
      }
    }

    // 9. Success Response
    console.log("--- HANDLER FINISHED SUCCESS ---");
    return {
      statusCode: 200,
      headers: corsHeaders(event),
      body: JSON.stringify({
        message: `Invitation ${responseData.response} successfully`,
        invitationId,
        jobId,
        response: responseData.response,
        applicationId,
        negotiationId,
        respondedAt: timestamp,
        jobType: jobType,
        nextSteps:
          responseData.response === "accepted"
            ? "Invitation accepted. You're scheduled — check your Scheduled tab."
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