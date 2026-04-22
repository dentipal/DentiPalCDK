import {
  DynamoDBClient,
  QueryCommand,
  BatchGetItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { CORS_HEADERS, setOriginFromEvent } from "./corsHeaders";
import { haversineDistance, type Coordinates } from "./geo";
import { fireAndForgetIncrement, PROMOTION_TIER_WEIGHT } from "./promotionCounters";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE || "DentiPal-V5-UserAddresses";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";

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
 * Get all jobIds + clinicIds the professional has already applied to.
 * Used for:
 *  - Excluding already-applied jobs from results (jobIds)
 *  - Boosting jobs from familiar clinics (clinicIds)
 */
interface AppliedInfo {
  jobIds: Set<string>;
  clinicIds: Set<string>;
}

export async function getAppliedJobInfo(userSub: string): Promise<AppliedInfo> {
  const jobIds = new Set<string>();
  const clinicIds = new Set<string>();
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: JOB_APPLICATIONS_TABLE,
        IndexName: "professionalUserSub-index",
        KeyConditionExpression: "professionalUserSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "jobId, clinicId",
        ExclusiveStartKey: lastKey,
      })
    );

    resp.Items?.forEach((item) => {
      const jid = str(item.jobId);
      const cid = str(item.clinicId);
      if (jid) jobIds.add(jid);
      if (cid) clinicIds.add(cid);
    });

    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  return { jobIds, clinicIds };
}

/**
 * Look up the professional's stored coordinates from the user-addresses table.
 * Returns null if the user has no address or no coordinates.
 */
export async function getProfessionalCoords(userSub: string): Promise<Coordinates | null> {
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: USER_ADDRESSES_TABLE,
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "lat, lng",
        Limit: 1,
      })
    );
    const item = resp.Items?.[0];
    if (!item) return null;
    const lat = num(item.lat);
    const lng = num(item.lng);
    if (lat === null || lng === null) return null;
    return { lat, lng };
  } catch {
    return null;
  }
}

/**
 * Fetch the raw job rows for every currently-active promotion.
 * Uses the status-expiresAt-index GSI so we never miss a boosted job
 * just because it falls outside the organic scan cap.
 *
 * The caller is still responsible for applying filters, radius, and dedupe.
 */
async function getActivePromotedJobItems(): Promise<Record<string, AttributeValue>[]> {
  const nowIso = new Date().toISOString();
  const promotions: Record<string, AttributeValue>[] = [];
  let lastKey: Record<string, AttributeValue> | undefined;

  do {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: JOB_PROMOTIONS_TABLE,
        IndexName: "status-expiresAt-index",
        KeyConditionExpression: "#s = :active AND expiresAt > :now",
        ExpressionAttributeNames: { "#s": "status" },
        ExpressionAttributeValues: {
          ":active": { S: "active" },
          ":now": { S: nowIso },
        },
        ExclusiveStartKey: lastKey,
      })
    );
    if (resp.Items) promotions.push(...resp.Items);
    lastKey = resp.LastEvaluatedKey;
  } while (lastKey);

  if (promotions.length === 0) return [];

  // Batch-get the underlying job rows. JobPostings PK is {clinicUserSub, jobId} —
  // both are stored on the promotion row so no secondary lookup is needed.
  const seen = new Set<string>();
  const keys: Record<string, AttributeValue>[] = [];
  for (const p of promotions) {
    const clinicUserSub = str(p.clinicUserSub);
    const jobId = str(p.jobId);
    if (!clinicUserSub || !jobId) continue;
    const k = `${clinicUserSub}#${jobId}`;
    if (seen.has(k)) continue;
    seen.add(k);
    keys.push({
      clinicUserSub: { S: clinicUserSub },
      jobId: { S: jobId },
    });
  }

  const jobs: Record<string, AttributeValue>[] = [];
  // BatchGetItem accepts up to 100 keys per call.
  for (let i = 0; i < keys.length; i += 100) {
    const chunk = keys.slice(i, i + 100);
    const resp = await ddb.send(
      new BatchGetItemCommand({
        RequestItems: { [JOB_POSTINGS_TABLE]: { Keys: chunk } },
      })
    );
    const rows = resp.Responses?.[JOB_POSTINGS_TABLE];
    if (rows) jobs.push(...rows);
  }

  return jobs;
}

/**
 * Read stored lat/lng from a job item. Returns null if not geocoded.
 */
export function getJobCoords(item: Record<string, AttributeValue>): Coordinates | null {
  const lat = num(item.lat);
  const lng = num(item.lng);
  if (lat === null || lng === null) return null;
  return { lat, lng };
}

/**
 * Compute a relevance score for a job based on available signals.
 * Higher = more relevant. Score range: 0-140 (with all bonuses).
 */
function computeRelevanceScore(job: Record<string, AttributeValue>, params: {
  role?: string;
  location?: string;
  distanceMi?: number | null;
  radiusMiles?: number;
  appliedClinicIds?: Set<string>;
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

  // Distance weighting (0-10): closer jobs score higher within the radius.
  // Only applied when user has a radius filter active and we computed a distance.
  if (params.distanceMi != null && params.radiusMiles && params.radiusMiles > 0) {
    const distanceScore = 10 * (1 - params.distanceMi / params.radiusMiles);
    score += Math.max(0, distanceScore);
  }

  // Applied-clinic boost (+15): user has applied to this clinic before.
  // Strong familiarity signal — they've engaged with the clinic before.
  if (params.appliedClinicIds && params.appliedClinicIds.size > 0) {
    const jobClinicId = str(job.clinicId);
    if (jobClinicId && params.appliedClinicIds.has(jobClinicId)) {
      score += 15;
    }
  }

  // Popularity (0-15): lifetime applicationsCount on a log scale so a single
  // viral job doesn't dominate. Old popular jobs still fade out via the
  // recency term above, so no rolling window is needed here.
  const apps = num(job.applicationsCount) ?? 0;
  if (apps > 0) {
    score += Math.min(15, Math.log(1 + apps) * 5);
  }

  return Math.round(score * 100) / 100;
}

/**
 * Check if a DynamoDB item matches the given filters.
 * Returns false if any active filter doesn't match.
 */
export function matchesFilters(item: Record<string, AttributeValue>, filters: {
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

  // Sort mode (Mercor-style dropdown): defaults to "trending" (current behavior).
  // "highestPay" sorts only the current page (cursor is keyed on createdAt).
  type SortMode = "trending" | "newest" | "highestPay" | "priority";
  const ALLOWED_SORTS: SortMode[] = ["trending", "newest", "highestPay", "priority"];
  const sort: SortMode = ALLOWED_SORTS.includes(qs.sort as SortMode)
    ? (qs.sort as SortMode)
    : "trending";

  // Live user location override (from browser geolocation on the frontend).
  // If provided, we use these coords instead of looking up the stored profile address.
  const userLatNum = qs.userLat ? Number(qs.userLat) : NaN;
  const userLngNum = qs.userLng ? Number(qs.userLng) : NaN;
  const liveUserCoords: Coordinates | null =
    Number.isFinite(userLatNum) && Number.isFinite(userLngNum)
      ? { lat: userLatNum, lng: userLngNum }
      : null;

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
    // 1) Get applied job/clinic info + resolve coords + fetch active promoted jobs.
    // Promoted jobs are fetched up-front so they're never dropped by the organic
    // scan cap — paid placement must always reach the pro.
    // Only include promoted jobs on the first page; cursor-paged requests are
    // organic-only so the same boosts don't follow the pro as they scroll.
    const needStoredCoords = radiusMiles && !liveUserCoords;
    const isFirstPage = !cursor;
    const [appliedInfo, storedCoords, promotedItems] = await Promise.all([
      getAppliedJobInfo(userSub),
      needStoredCoords ? getProfessionalCoords(userSub) : Promise.resolve(null as Coordinates | null),
      isFirstPage ? getActivePromotedJobItems() : Promise.resolve([] as Record<string, AttributeValue>[]),
    ]);

    const appliedJobIds = appliedInfo.jobIds;
    const appliedClinicIds = appliedInfo.clinicIds;

    const profCoords: Coordinates | null = liveUserCoords ?? storedCoords;
    console.log(`Excluding ${appliedJobIds.size} applied jobs. Boost: ${appliedClinicIds.size} familiar clinics. Radius: ${radiusMiles ?? "none"}, source: ${liveUserCoords ? "live browser" : storedCoords ? "saved profile" : "none"}, coords: ${profCoords ? `(${profCoords.lat}, ${profCoords.lng})` : "none"}`);

    // 2) Query the status-createdAt GSI for "open" jobs, newest first
    //    Falls back to scanning "active" status if "open" yields nothing
    const statusesToQuery = ["open", "active"];
    let matchedJobs: { item: Record<string, AttributeValue>; score: number; distanceMi?: number | null }[] = [];
    let nextKey: Record<string, AttributeValue> | undefined;

    // Decode incoming cursor. Two shapes are supported:
    //   1. A DynamoDB LastEvaluatedKey (resume a paused DDB scan).
    //   2. A synthetic { __overflowOffset: N } marker when the previous page returned
    //      overflow matches that didn't fit after slicing — we re-scan and slice from N.
    //      Needed because matchedJobs can exceed `limit` even after DDB is fully scanned
    //      (e.g., 80 rows in DDB, 60 match, page size 20 → 40 would otherwise be lost).
    let exclusiveStartKey: Record<string, AttributeValue> | undefined;
    let overflowOffset = 0;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64").toString("utf-8"));
        if (decoded && typeof decoded === "object" && decoded.__overflowOffset != null) {
          overflowOffset = Number(decoded.__overflowOffset) || 0;
        } else {
          exclusiveStartKey = decoded;
        }
      } catch {
        return json(400, { error: "Invalid cursor" });
      }
    }

    // The cursor is a DynamoDB LastEvaluatedKey from the status-createdAt-index GSI.
    // Its `status` attribute is the GSI partition key — DynamoDB will reject the query
    // if we hand this key to a KeyConditionExpression whose status doesn't match.
    // So: figure out which status the cursor came from, and resume iteration there.
    const cursorStatus = exclusiveStartKey?.status?.S;
    if (cursorStatus && !statusesToQuery.includes(cursorStatus)) {
      return json(400, { error: "Invalid cursor" });
    }
    const resumeStatuses = cursorStatus
      ? statusesToQuery.slice(statusesToQuery.indexOf(cursorStatus))
      : statusesToQuery;

    let totalScanned = 0;
    const MAX_SCAN = 500; // safety cap to prevent runaway queries

    // Split jobType out of the filter set so we can do two-phase matching:
    // phase 1 (non-jobType filters + radius) decides whether a row is in the
    // "filter-matching pool"; we bucket that pool by job_type into `counts`
    // and only then check jobType to decide whether the row enters the
    // page's matchedJobs. That way the header's per-type count reflects the
    // full pool instead of only the currently selected tab.
    const { jobType: selectedJobType, ...filtersSansJobType } = filters;
    const itemMatchesSelectedType = (jt: string): boolean => {
      if (!selectedJobType) return true;
      if (selectedJobType === "consulting") {
        return jt === "consulting" || jt === "multi_day_consulting";
      }
      return jt === selectedJobType;
    };

    const counts = { temporary: 0, multiday: 0, permanent: 0 };
    // Only populated on fresh scans — a mid-scan DDB-cursor resume would give
    // partial bucket counts (the skipped prefix wouldn't be counted).
    const computeCounts = !exclusiveStartKey;

    for (const status of resumeStatuses) {
      let statusStartKey = status === resumeStatuses[0] ? exclusiveStartKey : undefined;

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

          // Phase 1: everything except jobType
          if (!matchesFilters(item, filtersSansJobType)) continue;

          // Radius filter: skip jobs outside the professional's travel radius
          let distanceMi: number | null = null;
          if (radiusMiles && profCoords) {
            const jobCoords = getJobCoords(item);
            if (jobCoords) {
              distanceMi = haversineDistance(profCoords.lat, profCoords.lng, jobCoords.lat, jobCoords.lng);
              if (distanceMi > radiusMiles) continue; // too far — skip
            } else {
              // Job has no stored coords — cannot verify it's within radius, so exclude it
              continue;
            }
          }

          // Bucket into counts (regardless of which jobType tab is selected).
          const jt = (str(item.job_type) || str(item.jobType)).toLowerCase();
          if (computeCounts) {
            if (jt === "temporary") counts.temporary++;
            else if (jt === "permanent") counts.permanent++;
            else if (jt === "consulting" || jt === "multi_day_consulting") counts.multiday++;
          }

          // Phase 2: jobType gate for list inclusion.
          if (!itemMatchesSelectedType(jt)) continue;

          // Relevance score is only used for "trending"; skip the work otherwise.
          const score = sort === "trending"
            ? computeRelevanceScore(item, {
                role: filters.role,
                location: filters.location,
                distanceMi,
                radiusMiles,
                appliedClinicIds,
              })
            : 0;
          matchedJobs.push({ item, score, distanceMi });
        }

        statusStartKey = resp.LastEvaluatedKey;
        nextKey = resp.LastEvaluatedKey;

        // Only MAX_SCAN gates the loop now — the previous `matchedJobs.length >=
        // fetchLimit` short-circuit would cut counts short by aborting the scan
        // as soon as the page-sized matched buffer filled up.
        if (totalScanned >= MAX_SCAN) break;
      } while (statusStartKey);

      if (totalScanned >= MAX_SCAN) break;
    }

    // 2b) Score promoted jobs through the same filter/radius pipeline and merge.
    //     Promoted entries take priority over organic ones on jobId collision
    //     (the organic scan may surface the same job independently).
    if (promotedItems.length > 0) {
      const organicIds = new Set(matchedJobs.map((m) => str(m.item.jobId)));
      const promotedMatched: { item: Record<string, AttributeValue>; score: number; distanceMi?: number | null }[] = [];

      for (const item of promotedItems) {
        const jobId = str(item.jobId);
        if (!jobId || appliedJobIds.has(jobId)) continue;

        // Only surface jobs that are still open/active (promotion may outlive the job).
        const jobStatus = str(item.status);
        if (jobStatus !== "open" && jobStatus !== "active") continue;

        // Two-phase: gate by non-jobType filters first, bucket, then jobType.
        if (!matchesFilters(item, filtersSansJobType)) continue;

        let distanceMi: number | null = null;
        if (radiusMiles && profCoords) {
          const jobCoords = getJobCoords(item);
          if (jobCoords) {
            distanceMi = haversineDistance(profCoords.lat, profCoords.lng, jobCoords.lat, jobCoords.lng);
            if (distanceMi > radiusMiles) continue;
          } else {
            continue;
          }
        }

        const jt = (str(item.job_type) || str(item.jobType)).toLowerCase();
        if (computeCounts) {
          if (jt === "temporary") counts.temporary++;
          else if (jt === "permanent") counts.permanent++;
          else if (jt === "consulting" || jt === "multi_day_consulting") counts.multiday++;
        }

        if (!itemMatchesSelectedType(jt)) continue;

        const score = sort === "trending"
          ? computeRelevanceScore(item, {
              role: filters.role,
              location: filters.location,
              distanceMi,
              radiusMiles,
              appliedClinicIds,
            })
          : 0;
        promotedMatched.push({ item, score, distanceMi });
      }

      // Prepend promoted matches and drop organic duplicates — the sort will re-order,
      // but the dedupe prevents the same job from appearing twice in matchedJobs.
      if (promotedMatched.length > 0) {
        const promotedIds = new Set(promotedMatched.map((m) => str(m.item.jobId)));
        matchedJobs = matchedJobs.filter((m) => !promotedIds.has(str(m.item.jobId)));
        matchedJobs.unshift(...promotedMatched);

        console.log(`[Promotions] Surfaced ${promotedMatched.length} boosted jobs (organic had ${organicIds.size} candidates).`);
      }
    }

    // 3) Sort jobs based on the requested mode.
    //    "trending"  → promotion tier → relevance score → newest (legacy default)
    //    "newest"    → newest first
    //    "highestPay"→ highest rate first (cursor-paged within current page only)
    //    "priority"  → promoted first (by tier weight) → newest
    //    Expired promotions get weight 0 so they mix back into organic results.
    const activeTierWeight = (item: Record<string, AttributeValue>): number => {
      if (!item.isPromoted?.BOOL) return 0;
      const expiresAt = str(item.promotionExpiresAt);
      if (!expiresAt || new Date(expiresAt) <= new Date()) return 0;
      return PROMOTION_TIER_WEIGHT[str(item.promotionPlanId)] || 0;
    };

    const createdAtMs = (item: Record<string, AttributeValue>): number =>
      new Date(str(item.createdAt) || "0").getTime();

    const rateOf = (item: Record<string, AttributeValue>): number =>
      num(item.rate) ?? num(item.hourly_rate) ?? num(item.hourlyRate) ?? -1;

    matchedJobs.sort((a, b) => {
      switch (sort) {
        case "newest":
          return createdAtMs(b.item) - createdAtMs(a.item);

        case "highestPay": {
          const ra = rateOf(a.item);
          const rb = rateOf(b.item);
          if (rb !== ra) return rb - ra;
          return createdAtMs(b.item) - createdAtMs(a.item);
        }

        case "priority": {
          const wa = activeTierWeight(a.item);
          const wb = activeTierWeight(b.item);
          if (wa !== wb) return wb - wa;
          return createdAtMs(b.item) - createdAtMs(a.item);
        }

        case "trending":
        default: {
          const wa = activeTierWeight(a.item);
          const wb = activeTierWeight(b.item);
          if (wa !== wb) return wb - wa;
          if (b.score !== a.score) return b.score - a.score;
          return createdAtMs(b.item) - createdAtMs(a.item);
        }
      }
    });

    // 4) Slice to requested page size, honoring any in-memory offset from an
    //    earlier overflow page.
    const pageJobs = matchedJobs.slice(overflowOffset, overflowOffset + limit);

    // Two independent sources of "more":
    //   - DDB still has unseen rows (nextKey set).
    //   - We have overflow matches left over after slicing this page.
    // If both are true, prefer the overflow cursor — the DDB cursor would jump
    // past the leftover matches and the client would never see them.
    const hasDDBMore = !!nextKey;
    const hasOverflowMore = matchedJobs.length > overflowOffset + limit;
    const hasMore = hasDDBMore || hasOverflowMore;

    // 5) Build next cursor. Emit the DDB key only when there are no overflow
    //    matches still pending in the current matched set.
    let nextCursor: string | null = null;
    if (hasOverflowMore) {
      nextCursor = Buffer.from(
        JSON.stringify({ __overflowOffset: overflowOffset + limit })
      ).toString("base64");
    } else if (hasDDBMore && nextKey) {
      nextCursor = Buffer.from(JSON.stringify(nextKey)).toString("base64");
    }

    // When DDB is fully scanned, the matched set is the exact universe for
    // these filters — expose it so the UI can show "Showing X of N jobs".
    // When DDB still has more, the total is unknown.
    const totalMatched = hasDDBMore ? null : matchedJobs.length;

    // 6) Convert to plain objects and attach relevance score + distance.
    //    Mask expired promotions at read time so clients never see stale boosts.
    const jobs = pageJobs.map(({ item, score, distanceMi }) => {
      const obj: any = {
        ...itemToObject(item),
        _relevanceScore: score,
        ...(distanceMi != null && { _distanceMiles: Math.round(distanceMi * 10) / 10 }),
      };
      if (obj.isPromoted) {
        const stillActive = obj.promotionExpiresAt && new Date(obj.promotionExpiresAt) > new Date();
        if (!stillActive) {
          obj.isPromoted = false;
          delete obj.promotionId;
          delete obj.promotionPlanId;
          delete obj.promotionExpiresAt;
        }
      }
      return obj;
    });

    for (const j of jobs) {
      if (j.isPromoted && j.jobId && j.promotionId) {
        fireAndForgetIncrement(j.jobId, j.promotionId, "impressions");
      }
    }

    return json(200, {
      totalJobs: jobs.length,
      totalMatched,
      hasMore,
      nextCursor,
      jobs,
      // Per-type counts of the full filter-matched pool (non-jobType filters
      // only). Populated on fresh scans; omitted on DDB-cursor resumes since
      // those only see a suffix of the pool.
      counts: computeCounts ? counts : null,
      // True if MAX_SCAN capped us before DDB exhausted — counts are then
      // lower-bound approximations. Negligible at current data volumes.
      countsTruncated: computeCounts && hasDDBMore && totalScanned >= MAX_SCAN,
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
