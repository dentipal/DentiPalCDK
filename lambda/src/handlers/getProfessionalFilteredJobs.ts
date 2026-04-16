import {
  DynamoDBClient,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";
import { zipToCoords, haversineDistance, type Coordinates } from "./geo";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE || "DentiPal-V5-UserAddresses";

const ddb = new DynamoDBClient({ region: REGION });

const json = (statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: CORS_HEADERS,
  body: JSON.stringify(bodyObj),
});

const str = (attr: AttributeValue | undefined): string => {
  if (!attr || !("S" in attr)) return "";
  return (attr.S as string) || "";
};

const num = (attr: AttributeValue | undefined): number | null => {
  if (!attr || !("N" in attr)) return null;
  return parseFloat(attr.N as string);
};

function itemToObject(item: Record<string, AttributeValue>): any {
  const result: any = {};
  Object.entries(item).forEach(([key, attr]) => {
    if ("S" in attr) result[key] = attr.S;
    else if ("N" in attr) result[key] = parseFloat(attr.N as string);
    else if ("BOOL" in attr) result[key] = attr.BOOL;
    else if ("SS" in attr) result[key] = attr.SS;
    else if ("L" in attr) result[key] = attr.L;
    else if ("M" in attr) {
      // Recursively convert Map attributes
      result[key] = itemToObject(attr.M as Record<string, AttributeValue>);
    } else result[key] = attr;
  });
  return result;
}

/**
 * Get all jobIds the professional has already applied to,
 * using the professionalUserSub-index GSI.
 */
async function getAppliedJobIds(userSub: string): Promise<Set<string>> {
  const jobIds = new Set<string>();
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: JOB_APPLICATIONS_TABLE,
        IndexName: "professionalUserSub-index",
        KeyConditionExpression: "professionalUserSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "jobId",
        ExclusiveStartKey: lastKey,
      })
    );

    resp.Items?.forEach((item) => {
      const id = str(item.jobId);
      if (id) jobIds.add(id);
    });

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return jobIds;
}

/**
 * Look up the professional's zip code from the user-addresses table.
 */
async function getProfessionalZip(userSub: string): Promise<string | null> {
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: USER_ADDRESSES_TABLE,
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "pincode",
        Limit: 1,
      })
    );
    const item = resp.Items?.[0];
    if (!item) return null;
    return str(item.pincode) || null;
  } catch {
    return null;
  }
}

/**
 * Get the zip code (pincode) from a job DynamoDB item.
 * Checks both flat and nested location fields.
 */
function getJobZip(item: Record<string, AttributeValue>): string | null {
  // Check flat field first
  const flat = str(item.pincode) || str(item.zipCode) || str(item.zip);
  if (flat) return flat;

  // Check nested location object
  if (item.location && "M" in item.location) {
    const locMap = item.location.M as Record<string, AttributeValue>;
    return str(locMap?.zipCode) || str(locMap?.pincode) || str(locMap?.zip) || null;
  }
  return null;
}

/**
 * Compute a relevance score for a job based on available signals.
 * Higher = more relevant. Score range: 0-100.
 */
function computeRelevanceScore(job: Record<string, AttributeValue>, params: {
  role?: string;
  location?: string;
}): number {
  let score = 0;

  // Recency score (0-40): newer jobs score higher
  const createdAt = str(job.createdAt);
  if (createdAt) {
    const ageMs = Date.now() - new Date(createdAt).getTime();
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    // Jobs less than 1 day old get full 40 points, decays over 30 days
    score += Math.max(0, 40 * (1 - ageDays / 30));
  }

  // Role match score (0-30): exact or partial role match
  if (params.role) {
    const jobRole = (str(job.professional_role) || str(job.professionalRole)).toLowerCase();
    const filterRole = params.role.toLowerCase();
    if (jobRole === filterRole) {
      score += 30; // exact match
    } else if (jobRole.includes(filterRole) || filterRole.includes(jobRole)) {
      score += 15; // partial match
    }
  }

  // Rate score (0-20): jobs with higher rates score higher
  const rate = num(job.rate) ?? num(job.hourly_rate) ?? num(job.hourlyRate) ?? 0;
  // Cap at $200/hr for normalization
  score += Math.min(20, (rate / 200) * 20);

  // Has complete info bonus (0-10): jobs with all details filled score higher
  let completeness = 0;
  if (str(job.date) || job.dates) completeness += 2.5;
  if (str(job.start_time) || str(job.startTime)) completeness += 2.5;
  if (str(job.professional_role) || str(job.professionalRole)) completeness += 2.5;
  if (rate > 0) completeness += 2.5;
  score += completeness;

  return Math.round(score * 100) / 100;
}

/**
 * Check if a DynamoDB item matches the given filters.
 * Returns false if any active filter doesn't match.
 */
function matchesFilters(item: Record<string, AttributeValue>, filters: {
  role?: string;
  jobType?: string;
  location?: string;
  minRate?: number;
  maxRate?: number;
  payType?: string;
  workLocationType?: string;
  startDate?: string;
  endDate?: string;
}): boolean {
  // Role filter
  if (filters.role) {
    const jobRole = (str(item.professional_role) || str(item.professionalRole)).toLowerCase();
    const filterRole = filters.role.toLowerCase();
    // Flexible match: exact, contains, or word overlap
    const matches = jobRole === filterRole
      || jobRole.includes(filterRole)
      || filterRole.includes(jobRole)
      || filterRole.split(/[\s_]+/).some(w => w.length > 3 && jobRole.includes(w));
    if (!matches) return false;
  }

  // Job type filter
  if (filters.jobType) {
    const jt = (str(item.job_type) || str(item.jobType)).toLowerCase();
    if (filters.jobType === "consulting") {
      if (jt !== "consulting" && jt !== "multi_day_consulting") return false;
    } else if (jt !== filters.jobType) {
      return false;
    }
  }

  // Location filter (substring match on city/state/address)
  if (filters.location) {
    const locFilter = filters.location.toLowerCase();
    const city = str(item.city).toLowerCase();
    const state = str(item.state).toLowerCase();
    const address = str(item.addressLine1).toLowerCase();
    // Also check nested location object
    let nestedCity = "";
    let nestedState = "";
    if (item.location && "M" in item.location) {
      const locMap = item.location.M as Record<string, AttributeValue>;
      nestedCity = str(locMap?.city).toLowerCase();
      nestedState = str(locMap?.state).toLowerCase();
    }
    const allLoc = `${city} ${state} ${address} ${nestedCity} ${nestedState}`;
    if (!allLoc.includes(locFilter)) return false;
  }

  // Rate filter
  const rate = num(item.rate) ?? num(item.hourly_rate) ?? num(item.hourlyRate)
    ?? num(item.rate_per_transaction) ?? num(item.ratePerTransaction)
    ?? num(item.revenue_percentage) ?? num(item.revenuePercentage) ?? null;
  if (filters.minRate != null && (rate === null || rate < filters.minRate)) return false;
  if (filters.maxRate != null && (rate === null || rate > filters.maxRate)) return false;

  // Pay type filter
  if (filters.payType) {
    const jpt = (str(item.pay_type) || str(item.payType)).toLowerCase();
    if (filters.payType === "hourly") {
      // Default/empty pay type is treated as hourly
      if (jpt && jpt !== "hourly") return false;
    } else if (jpt !== filters.payType) {
      return false;
    }
  }

  // Work location type filter
  if (filters.workLocationType) {
    const wlt = (str(item.work_location_type) || str(item.workLocationType)).toLowerCase();
    if (wlt !== filters.workLocationType.toLowerCase()) return false;
  }

  // Date range filter
  if (filters.startDate || filters.endDate) {
    const jobDate = str(item.date);
    if (jobDate) {
      if (filters.startDate && jobDate < filters.startDate) return false;
      if (filters.endDate && jobDate > filters.endDate) return false;
    }
    // Don't exclude jobs with no date — they might be permanent roles
  }

  return true;
}


export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {
    setOriginFromEvent(event);
  const method = (event.requestContext as any)?.http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS")
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  if (method !== "GET") return json(405, { error: "Method not allowed" });

  let userSub: string | undefined;
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return json(401, { error: "Missing Authorization header" });
    userSub = extractUserFromBearerToken(authHeader).sub;
    if (!userSub) return json(401, { error: "User sub missing in token" });
  } catch (e: any) {
    return json(401, { error: "Unauthorized", reason: e?.message });
  }

  // Parse query parameters
  const qs = event.queryStringParameters || {};
  const limit = Math.min(Number(qs.limit || 20), 100);
  const cursor = qs.cursor || undefined; // opaque base64-encoded LastEvaluatedKey

  const radiusMiles = qs.radius ? Number(qs.radius) : undefined;

  const filters = {
    role: qs.role || undefined,
    jobType: qs.jobType || undefined,
    location: qs.location || undefined,
    minRate: qs.minRate ? Number(qs.minRate) : undefined,
    maxRate: qs.maxRate ? Number(qs.maxRate) : undefined,
    payType: qs.payType || undefined,
    workLocationType: qs.workLocationType || undefined,
    startDate: qs.start || undefined,
    endDate: qs.end || undefined,
  };

  try {
    // 1) Get jobIds the professional has already applied to
    // + resolve professional's coordinates for radius filtering (in parallel)
    const [appliedJobIds, profZip] = await Promise.all([
      getAppliedJobIds(userSub),
      radiusMiles ? getProfessionalZip(userSub) : Promise.resolve(null),
    ]);

    const profCoords: Coordinates | null = profZip ? zipToCoords(profZip) : null;
    console.log(`Excluding ${appliedJobIds.size} applied jobs. Radius: ${radiusMiles ?? "none"}, profZip: ${profZip ?? "none"}`);

    // 2) Query the status-createdAt GSI for "open" jobs, newest first
    //    Falls back to scanning "active" status if "open" yields nothing
    const statusesToQuery = ["open", "active"];
    let matchedJobs: { item: Record<string, AttributeValue>; score: number; distanceMi?: number | null }[] = [];
    let nextKey: Record<string, AttributeValue> | undefined;

    // Decode incoming cursor
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    if (cursor) {
      try {
        exclusiveStartKey = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
      } catch {
        return json(400, { error: "Invalid cursor" });
      }
    }

    // We need to over-fetch because we filter out applied jobs and non-matching filters
    // Fetch up to 5x the limit to have enough after filtering
    const fetchLimit = limit * 5;
    let totalScanned = 0;
    const MAX_SCAN = 500; // safety cap to prevent runaway queries

    for (const status of statusesToQuery) {
      let statusStartKey = status === statusesToQuery[0] ? exclusiveStartKey : undefined;

      do {
        const resp = await ddb.send(
          new QueryCommand({
            TableName: JOB_POSTINGS_TABLE,
            IndexName: "status-createdAt-index",
            KeyConditionExpression: "#s = :status",
            ExpressionAttributeNames: { "#s": "status" },
            ExpressionAttributeValues: { ":status": { S: status } },
            ScanIndexForward: false, // newest first
            Limit: 100,
            ExclusiveStartKey: statusStartKey,
          })
        );

        for (const item of resp.Items || []) {
          totalScanned++;
          const jobId = str(item.jobId);

          // Skip already-applied jobs
          if (appliedJobIds.has(jobId)) continue;

          // Apply server-side filters
          if (!matchesFilters(item, filters)) continue;

          // Radius filter: skip jobs outside the professional's travel radius
          let distanceMi: number | null = null;
          if (radiusMiles && profCoords) {
            const jobZip = getJobZip(item);
            const jobCoords = zipToCoords(jobZip ?? undefined);
            if (jobCoords) {
              distanceMi = haversineDistance(profCoords.lat, profCoords.lng, jobCoords.lat, jobCoords.lng);
              if (distanceMi > radiusMiles) continue; // too far — skip
            }
            // If job has no zip, don't exclude it — let it through
          }

          // Compute relevance score
          const score = computeRelevanceScore(item, { role: filters.role, location: filters.location });
          matchedJobs.push({ item, score, distanceMi });
        }

        statusStartKey = resp.LastEvaluatedKey;
        nextKey = resp.LastEvaluatedKey;

        // Stop if we have enough results or hit safety cap
        if (matchedJobs.length >= fetchLimit || totalScanned >= MAX_SCAN) break;
      } while (statusStartKey);

      if (matchedJobs.length >= fetchLimit || totalScanned >= MAX_SCAN) break;
    }

    // 3) Sort by relevance score (descending), then by createdAt as tiebreaker
    matchedJobs.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const dateA = new Date(str(a.item.createdAt) || "0").getTime();
      const dateB = new Date(str(b.item.createdAt) || "0").getTime();
      return dateB - dateA;
    });

    // 4) Slice to requested page size
    const pageJobs = matchedJobs.slice(0, limit);
    const hasMore = matchedJobs.length > limit || !!nextKey;

    // 5) Build next cursor from the DynamoDB LastEvaluatedKey
    let nextCursor: string | null = null;
    if (hasMore && nextKey) {
      nextCursor = Buffer.from(JSON.stringify(nextKey)).toString("base64");
    }

    // 6) Convert to plain objects and attach relevance score + distance
    const jobs = pageJobs.map(({ item, score, distanceMi }) => ({
      ...itemToObject(item),
      _relevanceScore: score,
      ...(distanceMi != null && { _distanceMiles: Math.round(distanceMi * 10) / 10 }),
    }));

    return json(200, {
      totalJobs: jobs.length,
      hasMore,
      nextCursor,
      jobs,
    });

  } catch (err: any) {
    console.error("Handler Fatal Error:", err);
    return json(500, {
      error: "Internal Server Error",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
