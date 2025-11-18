"use strict";
const {
  DynamoDBClient,
  QueryCommand,
  UpdateItemCommand,
  GetItemCommand,
} = require("@aws-sdk/client-dynamodb");
const { validateToken } = require("./utils");

const dynamodb = new DynamoDBClient({ region: process.env.REGION });

// ---- CORS ----
const getCorsHeaders = (event) => {
  const origin = event?.headers?.origin || event?.headers?.Origin || "";
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers":
      "Content-Type,Authorization,X-Requested-With",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,DELETE",
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
};

// ---- helpers ----
const numFrom = (val) => {
  if (!val) return null;
  if (typeof val.N === "string") return Number(val.N);
  if (typeof val.S === "string" && val.S.trim() !== "" && !isNaN(+val.S))
    return Number(val.S);
  return null;
};

const strFrom = (val) => {
  if (!val) return null;
  if (typeof val.S === "string") return val.S;
  if (typeof val.N === "string") return val.N;
  return null;
};

// soft parse an app’s proposed rate with a few common attribute names
const getAppProposedRate = (appItem) => {
  return (
    numFrom(appItem?.proposedRate) ??
    numFrom(appItem?.proposedHourlyRate) ??
    numFrom(appItem?.hourlyProposedRate) ??
    numFrom(appItem?.rate) ??
    null
  );
};

exports.handler = async (event) => {
  try {
    const userSub = await validateToken(event); // caller's sub (clinic or professional)
    const body = JSON.parse(event.body || "{}");

    // path: /applications/{applicationId}/negotiations/{negotiationId}/response
    const path = event.path || "";
    const parts = path.split("/"); // ["", "applications", "{applicationId}", "negotiations", "{negotiationId}", ...]
    const applicationId = parts[2];
    const negotiationId = parts[4];

    if (!applicationId || !negotiationId) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: "negotiationId and applicationId are required in path",
        }),
      };
    }

    const valid = ["accepted", "declined", "counter_offer"];
    if (!body.response || !valid.includes(body.response)) {
      return {
        statusCode: 400,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error:
            "response is required and must be one of: accepted, declined, counter_offer",
        }),
      };
    }

    // 1) Load negotiation
    const negotiationRes = await dynamodb.send(
      new GetItemCommand({
        TableName: process.env.JOB_NEGOTIATIONS_TABLE,
        Key: {
          applicationId: { S: applicationId },
          negotiationId: { S: negotiationId },
        },
      })
    );

    if (!negotiationRes.Item) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Negotiation not found" }),
      };
    }

    const negotiationItem = negotiationRes.Item;
    const jobId = strFrom(negotiationItem.jobId);

    // 2) Load job (to get clinic owner)
    const jobRes = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.JOB_POSTINGS_TABLE,
        IndexName: "JobIdIndex",
        KeyConditionExpression: "jobId = :jobId",
        ExpressionAttributeValues: {
          ":jobId": { S: jobId },
        },
      })
    );

    if (!jobRes.Items || jobRes.Items.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Job not found or no permission" }),
      };
    }

    const jobItem = jobRes.Items[0];
    const jobType = strFrom(jobItem.job_type) || strFrom(jobItem.jobType);
    const clinicUserSub =
      strFrom(jobItem.clinicUserSub) || strFrom(jobItem.createdBy);

    // 3) Load application (via GSI)
    const appRes = await dynamodb.send(
      new QueryCommand({
        TableName: process.env.JOB_APPLICATIONS_TABLE,
        IndexName: "applicationId-index",
        KeyConditionExpression: "applicationId = :applicationId",
        ExpressionAttributeValues: {
          ":applicationId": { S: applicationId },
        },
      })
    );

    if (!appRes.Items || appRes.Items.length === 0) {
      return {
        statusCode: 404,
        headers: getCorsHeaders(event),
        body: JSON.stringify({ error: "Application not found" }),
      };
    }

    const appItem = appRes.Items[0];
    const professionalUserSub = strFrom(appItem.professionalUserSub);

    // 4) Figure out actor
    const actor =
      userSub === clinicUserSub
        ? "clinic"
        : userSub === professionalUserSub
        ? "professional"
        : null;

    if (!actor) {
      return {
        statusCode: 403,
        headers: getCorsHeaders(event),
        body: JSON.stringify({
          error: "Not authorized for this negotiation",
        }),
      };
    }

    const timestamp = new Date().toISOString();

    // 5) Validate counter_offer payload for hourly/permanent
    if (body.response === "counter_offer") {
      if ((jobType || "").toLowerCase() === "permanent") {
        if (
          typeof body.counterSalaryMin !== "number" ||
          typeof body.counterSalaryMax !== "number"
        ) {
          return {
            statusCode: 400,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error:
                "counterSalaryMin and counterSalaryMax are required for permanent job counter offers",
            }),
          };
        }
        if (body.counterSalaryMax < body.counterSalaryMin) {
          return {
            statusCode: 400,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error: "counterSalaryMax must be greater than counterSalaryMin",
            }),
          };
        }
      } else {
        if (
          typeof body.clinicCounterHourlyRate !== "number" &&
          typeof body.professionalCounterHourlyRate !== "number"
        ) {
          return {
            statusCode: 400,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error:
                "clinicCounterHourlyRate or professionalCounterHourlyRate is required for hourly job counter offers",
            }),
          };
        }
      }
    }

    // 6) Build negotiation update (actor-specific fields)
    const isAccepted = body.response === "accepted";
    const isDeclined = body.response === "declined";
    const isCounter = body.response === "counter_offer";

    const attrNames = {
      "#status": "negotiationStatus",
      "#updatedAt": "updatedAt",
    };
    const attrValues = {
      ":status": { S: body.response },
      ":updatedAt": { S: timestamp },
    };
    let updateExpr = "SET #status = :status, #updatedAt = :updatedAt";

    // actor-specific response/message/timestamps
    if (actor === "clinic") {
      attrNames["#actorResponse"] = "clinicResponse";
      attrNames["#actorMessage"] = "clinicMessage";
      attrNames["#actorRespondedAt"] = "clinicRespondedAt";
    } else {
      attrNames["#actorResponse"] = "professionalResponse";
      attrNames["#actorMessage"] = "professionalMessage";
      attrNames["#actorRespondedAt"] = "professionalRespondedAt";
    }
    attrValues[":actorResponse"] = { S: body.response };
    attrValues[":actorMessage"] = { S: body.message || "" };
    attrValues[":actorRespondedAt"] = { S: timestamp };
    updateExpr +=
      ", #actorResponse = :actorResponse, #actorMessage = :actorMessage, #actorRespondedAt = :actorRespondedAt";

    // attach counter rates if present
    if (typeof body.clinicCounterHourlyRate === "number") {
      attrNames["#clinicCounterHourlyRate"] = "clinicCounterHourlyRate";
      attrValues[":clinicCounterHourlyRate"] = {
        N: String(body.clinicCounterHourlyRate),
      };
      updateExpr +=
        ", #clinicCounterHourlyRate = :clinicCounterHourlyRate";
    }
    if (typeof body.professionalCounterHourlyRate === "number") {
      attrNames["#professionalCounterHourlyRate"] =
        "professionalCounterHourlyRate";
      attrValues[":professionalCounterHourlyRate"] = {
        N: String(body.professionalCounterHourlyRate),
      };
      updateExpr +=
        ", #professionalCounterHourlyRate = :professionalCounterHourlyRate";
    }

    // Optionally store agreed rate when accepted
    let finalAcceptedHourlyRate = null;

    if (isAccepted && (jobType || "").toLowerCase() !== "permanent") {
      // Hourly paths only (temporary / multi-day)
      const clinicCounter =
        numFrom(negotiationItem.clinicCounterHourlyRate) ??
        (typeof body.clinicCounterHourlyRate === "number"
          ? body.clinicCounterHourlyRate
          : null);
      const professionalCounter =
        numFrom(negotiationItem.professionalCounterHourlyRate) ??
        (typeof body.professionalCounterHourlyRate === "number"
          ? body.professionalCounterHourlyRate
          : null);

      if (actor === "professional") {
        // professional accepts -> accept clinic's counter
        if (clinicCounter == null) {
          return {
            statusCode: 400,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error:
                "Cannot accept: clinicCounterHourlyRate not found on negotiation",
            }),
          };
        }
        finalAcceptedHourlyRate = clinicCounter;
      } else {
        // clinic accepts -> accept professional's counter or fallback to application proposed rate
        const appProposed = getAppProposedRate(appItem);
        if (professionalCounter == null && appProposed == null) {
          return {
            statusCode: 400,
            headers: getCorsHeaders(event),
            body: JSON.stringify({
              error:
                "Cannot accept: no professionalCounterHourlyRate on negotiation and no proposedRate on application",
            }),
          };
        }
        finalAcceptedHourlyRate =
          professionalCounter != null ? professionalCounter : appProposed;
      }

      // write a canonical agreed rate to negotiation row as well
      attrNames["#agreedHourlyRate"] = "agreedHourlyRate";
      attrValues[":agreedHourlyRate"] = {
        N: String(finalAcceptedHourlyRate),
      };
      updateExpr += ", #agreedHourlyRate = :agreedHourlyRate";
    }

    // Write negotiation update
    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.JOB_NEGOTIATIONS_TABLE,
        Key: {
          applicationId: { S: applicationId },
          negotiationId: { S: negotiationId },
        },
        UpdateExpression: updateExpr,
        ExpressionAttributeNames: attrNames,
        ExpressionAttributeValues: attrValues,
      })
    );

    // 7) Determine applicationStatus
    // requested: on any accept → scheduled
    let applicationStatus = "negotiating";
    if (isAccepted) applicationStatus = "scheduled";
    else if (isDeclined) applicationStatus = "declined";
    else if (isCounter) applicationStatus = "negotiating";

    // 8) Update application status (+ accepted rate if we have one)
    const appUpdateNames = {
      "#status": "applicationStatus",
      "#updatedAt": "updatedAt",
    };
    const appUpdateValues = {
      ":status": { S: applicationStatus },
      ":updatedAt": { S: timestamp },
    };
    let appUpdateExpr = "SET #status = :status, #updatedAt = :updatedAt";

    if (finalAcceptedHourlyRate != null) {
      // set both keys for compatibility with your FE/backends
      appUpdateNames["#acceptedHourlyRate"] = "acceptedHourlyRate";
      appUpdateNames["#acceptedRate"] = "acceptedRate";
      appUpdateValues[":acceptedHourlyRate"] = {
        N: String(finalAcceptedHourlyRate),
      };
      appUpdateValues[":acceptedRate"] = {
        N: String(finalAcceptedHourlyRate),
      };
      appUpdateExpr +=
        ", #acceptedHourlyRate = :acceptedHourlyRate, #acceptedRate = :acceptedRate";
    }

    await dynamodb.send(
      new UpdateItemCommand({
        TableName: process.env.JOB_APPLICATIONS_TABLE,
        Key: {
          jobId: { S: jobId },
          // always use the application's professional SK, not the caller
          professionalUserSub: { S: professionalUserSub },
        },
        UpdateExpression: appUpdateExpr,
        ExpressionAttributeNames: appUpdateNames,
        ExpressionAttributeValues: appUpdateValues,
      })
    );

    // (Optional) If you want to mirror job status on accept:
    // if (isAccepted) {
    //   await dynamodb.send(new UpdateItemCommand({
    //     TableName: process.env.JOB_POSTINGS_TABLE,
    //     Key: { id: jobItem.id /* your PK here */ },
    //     UpdateExpression: "SET #jobStatus = :scheduled, #updatedAt = :updatedAt",
    //     ExpressionAttributeNames: { "#jobStatus": "status", "#updatedAt": "updatedAt" },
    //     ExpressionAttributeValues: { ":scheduled": { S: "scheduled" }, ":updatedAt": { S: timestamp } }
    //   }));
    // }

    return {
      statusCode: 200,
      headers: getCorsHeaders(event),
      body: JSON.stringify({
        message: `Negotiation ${body.response} successfully`,
        negotiationId,
        applicationId,
        jobId,
        actor, // "clinic" | "professional"
        response: body.response,
        applicationStatus,
        acceptedHourlyRate: finalAcceptedHourlyRate ?? undefined,
        respondedAt: timestamp,
        nextSteps: isAccepted
          ? "Job has been scheduled with negotiated terms."
          : isCounter
          ? "Counter-offer sent; the other party will review."
          : "Negotiation declined.",
      }),
    };
  } catch (error) {
    console.error("Error responding to negotiation:", error);
    return {
      statusCode: 500,
      headers: getCorsHeaders(event),
      body: JSON.stringify({ error: error.message }),
    };
  }
};
