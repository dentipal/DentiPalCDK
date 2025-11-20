/* eslint-disable @typescript-eslint/no-explicit-any */
"use strict";

import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  BatchGetItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import {CORS_HEADERS} from "./corsHeaders";
// ---- env / config ----
const REGION: string =
  process.env.REGION || process.env.AWS_REGION || "us-east-1";

// Applications table
const APPLICATIONS_TABLE: string =
  process.env.JOB_APPLICATIONS_TABLE || "DentiPal-JobApplications";

// Job postings table (PK: clinicUserSub, SK: jobId)
const POSTINGS_TABLE: string =
  process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

// Professional profiles (PK: userSub)
const PROFESSIONAL_PROFILES_TABLE: string =
  process.env.PROFESSIONAL_PROFILES_TABLE || "DentiPal-ProfessionalProfiles";

// Job negotiations table (PK: negotiationId)
const NEGOTIATIONS_TABLE: string =
  process.env.JOB_NEGOTIATIONS_TABLE || "DentiPal-JobNegotiations";

const ddb = new DynamoDBClient({ region: REGION });

// Helper to build JSON responses with shared CORS
const json = (statusCode: number, bodyObj: object): any => ({
    statusCode,
    headers: CORS_HEADERS,
    body: JSON.stringify(bodyObj)
});



// ---------- helpers ----------
const JJ = (x: any): string => {
  try {
    return JSON.stringify(x, null, 2);
  } catch {
    return String(x);
  }
};

function getClinicIdFromPath(event: any): string | undefined {
  const pp = event?.pathParameters || {};
  if (pp.clinicId) return String(pp.clinicId);

  if (pp.proxy) {
    const parts = String(pp.proxy).split("/").filter(Boolean);
    const jobsIdx = parts.findIndex((p: string) => p.toLowerCase() === "jobs");
    if (jobsIdx > 0) return parts[jobsIdx - 1];
  }

  const p = event?.path || event?.rawPath || "";
  const parts = p.split("/").filter(Boolean);
  const jobsIdx = parts.findIndex((seg: string) => seg.toLowerCase() === "jobs");
  if (jobsIdx > 0) return parts[jobsIdx - 1];

  return undefined;
}

/** Query postings table for all jobs of a clinic (PK = clinicUserSub). */
async function listClinicJobs(clinicId: string): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const res = await ddb.send(
      new QueryCommand({
        TableName: POSTINGS_TABLE,
        KeyConditionExpression: "#pk = :c",
        ExpressionAttributeNames: { "#pk": "clinicUserSub" },
        ExpressionAttributeValues: { ":c": { S: String(clinicId) } },
        ExclusiveStartKey,
      })
    );
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/** Scan applications for this clinicId + jobId. */
async function listApplicationsForJob(
  clinicId: string,
  jobId: string
): Promise<Record<string, AttributeValue>[]> {
  const items: Record<string, AttributeValue>[] = [];
  let ExclusiveStartKey: Record<string, AttributeValue> | undefined;

  do {
    const res = await ddb.send(
      new ScanCommand({
        TableName: APPLICATIONS_TABLE,
        FilterExpression: "#clinic = :c AND #job = :j",
        ExpressionAttributeNames: { "#clinic": "clinicId", "#job": "jobId" },
        ExpressionAttributeValues: {
          ":c": { S: String(clinicId) },
          ":j": { S: String(jobId) },
        },
        ExclusiveStartKey,
      })
    );
    if (res.Items?.length) items.push(...res.Items);
    ExclusiveStartKey = res.LastEvaluatedKey;
  } while (ExclusiveStartKey);

  return items;
}

/** BatchGet professional profiles by userSub; returns Map<userSub, Item>. */
async function batchGetProfiles(
  userSubs: string[]
): Promise<Map<string, Record<string, AttributeValue>>> {
  const out = new Map<string, Record<string, AttributeValue>>();
  const CHUNK = 100;

  for (let i = 0; i < userSubs.length; i += CHUNK) {
    const keys = userSubs.slice(i, i + CHUNK).map((u) => ({ userSub: { S: String(u) } }));
    if (!keys.length) continue;

    const res = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [PROFESSIONAL_PROFILES_TABLE]: { Keys: keys },
        },
      })
    );

    const found = res?.Responses?.[PROFESSIONAL_PROFILES_TABLE] || [];
    for (const item of found) {
      const k = item?.userSub?.S;
      if (k) out.set(k, item);
    }

    const unprocessed = res?.UnprocessedKeys?.[PROFESSIONAL_PROFILES_TABLE];
    if (unprocessed?.Keys?.length) {
      const retry = await ddb.send(
        new BatchGetItemCommand({
          RequestItems: { [PROFESSIONAL_PROFILES_TABLE]: unprocessed },
        })
      );
      const retryFound = retry?.Responses?.[PROFESSIONAL_PROFILES_TABLE] || [];
      for (const item of retryFound) {
        const k = item?.userSub?.S;
        if (k) out.set(k, item);
      }
    }
  }

  return out;
}

/** BatchGet negotiations by negotiationId; returns Map<negotiationId, Item>. */
async function batchGetNegotiations(
  negIds: string[]
): Promise<Map<string, Record<string, AttributeValue>>> {
  const out = new Map<string, Record<string, AttributeValue>>();
  const CHUNK = 100;

  for (let i = 0; i < negIds.length; i += CHUNK) {
    const keys = negIds.slice(i, i + CHUNK).map((id) => ({ negotiationId: { S: String(id) } }));
    if (!keys.length) continue;

    const res = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: {
          [NEGOTIATIONS_TABLE]: { Keys: keys },
        },
      })
    );

    const found = res?.Responses?.[NEGOTIATIONS_TABLE] || [];
    for (const item of found) {
      const k = item?.negotiationId?.S;
      if (k) out.set(k, item);
    }

    const unprocessed = res?.UnprocessedKeys?.[NEGOTIATIONS_TABLE];
    if (unprocessed?.Keys?.length) {
      const retry = await ddb.send(
        new BatchGetItemCommand({
          RequestItems: { [NEGOTIATIONS_TABLE]: unprocessed },
        })
      );
      const retryFound = retry?.Responses?.[NEGOTIATIONS_TABLE] || [];
      for (const item of retryFound) {
        const k = item?.negotiationId?.S;
        if (k) out.set(k, item);
      }
    }
  }

  return out;
}

// ---------- handler ----------
export const handler = async (event: any) => {
  const method =
    event?.requestContext?.http?.method || event?.httpMethod || "GET";

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  console.log("============= 🟦 getJobApplicationsForClinic START");
  console.log("Raw event:", JJ(event));

  try {
    const clinicId = getClinicIdFromPath(event);
    if (!clinicId) {
      return json(400, {
        error: "Bad Request",
        statusCode: 400,
        message: "Clinic ID is required",
        details: { pathFormat: "/{clinicId}/jobs" },
        timestamp: new Date().toISOString()
      });
    }

    const jobs = await listClinicJobs(clinicId);
    console.log(`Found ${jobs.length} job postings for clinic ${clinicId}`);

    const jobRows = await Promise.all(
      jobs.map(async (job: any) => {
        const jobId = job?.jobId?.S;
        if (!jobId) return null;

        const applications = await listApplicationsForJob(clinicId, jobId);
        return {
          jobId,
          jobPosting: job,
          applicants: applications,
        };
      })
    );

    const grouped = jobRows.filter(Boolean) as any[];

    const allSubs = Array.from(
      new Set(
        grouped.flatMap((jr: any) =>
          (jr.applicants || [])
            .map(
              (a: any) =>
                a?.professionalUserSub?.S ||
                a?.applicantUserSub?.S ||
                a?.userSub?.S ||
                null
            )
            .filter(Boolean)
        )
      )
    ) as string[];

    const profileMap =
      allSubs.length > 0 ? await batchGetProfiles(allSubs) : new Map();

    const allNegIds = Array.from(
      new Set(
        grouped.flatMap((jr: any) =>
          (jr.applicants || [])
            .map((a: any) => a?.negotiationId?.S || null)
            .filter(Boolean)
        )
      )
    ) as string[];

    const negMap =
      allNegIds.length > 0 ? await batchGetNegotiations(allNegIds) : new Map();

    for (const jr of grouped) {
      jr.applicants = (jr.applicants || []).map((a: any) => {
        const sub =
          a?.professionalUserSub?.S ||
          a?.applicantUserSub?.S ||
          a?.userSub?.S ||
          undefined;
        const profileItem = sub ? profileMap.get(sub) : undefined;

        const negId = a?.negotiationId?.S;
        const negotiationItem = negId ? negMap.get(negId) : undefined;

        return {
          ...a,
          professionalProfile: profileItem,
          negotiation: negotiationItem,
        };
      });
    }

    console.log(`Returning ${grouped.length} job buckets with applicants`);
    console.log("============= 🟩 getJobApplicationsForClinic END");

    return json(200, {
      status: "success",
      statusCode: 200,
      message: "Clinic job applications retrieved successfully",
      data: {
        clinicId: clinicId,
        jobs: grouped,
        totalApplicants: grouped.reduce(
          (s: number, r: any) => s + (r.applicants?.length || 0),
          0
        )
      },
      timestamp: new Date().toISOString()
    });
  } catch (err: any) {
    console.error("❌ Handler error:", err);
    console.log("============= 🟥 getJobApplicationsForClinic END (ERROR)");
    return json(500, {
      error: "Internal Server Error",
      statusCode: 500,
      message: "Failed to fetch clinic job applicants",
      details: { reason: err.message },
      timestamp: new Date().toISOString()
    });
  }
};
