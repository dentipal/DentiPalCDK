import {
  DynamoDBClient,
  QueryCommand,
  BatchGetItemCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "./utils";
import { corsHeaders } from "./corsHeaders";
import { haversineDistance, type Coordinates } from "./geo";
import { fireAndForgetIncrement, PROMOTION_TIER_WEIGHT } from "./promotionCounters";
import {
  getProfessionalAvailability,
  jobMatchesWeekdays,
  getScheduledOccurrences,
  dateIsBlocked,
  jobConflictsWithScheduled,
  jobDates,
} from "./professionalAvailability";
import {
  getProfessionalPreferences,
  DEFAULT_PREFERENCES,
  type ProfessionalPreferences,
} from "./professionalPreferences";

const REGION = process.env.REGION || "us-east-1";
const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";
const USER_ADDRESSES_TABLE = process.env.USER_ADDRESSES_TABLE || "DentiPal-V5-UserAddresses";
const JOB_PROMOTIONS_TABLE = process.env.JOB_PROMOTIONS_TABLE || "DentiPal-V5-JobPromotions";
const CLINIC_PROFILES_TABLE = process.env.CLINIC_PROFILES_TABLE || "DentiPal-V5-ClinicProfiles";

const ddb = new DynamoDBClient({ region: REGION });

const json = (event: any, statusCode: number, bodyObj: any): APIGatewayProxyResult => ({
  statusCode,
  headers: corsHeaders(event),
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

/**
 * Returns true if every scheduled date on this job is strictly in the past.
 * - Multi-day consulting: past only when EVERY date in `dates` is past.
 * - Temporary: single `date` field.
 * - Permanent: uses `date` / `start_date` / `startDate` when present;
 *   open-ended postings (no date at all) are never considered past.
 *
 * The frontend used to do this filter — moving it server-side so
 * `totalMatched` and the per-type counts match what the UI actually shows.
 */
function isJobFullyPast(item: Record<string, AttributeValue>): boolean {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  let datesList: string[] = [];
  const datesAttr = item.dates;
  if (datesAttr) {
    if ("SS" in datesAttr && Array.isArray(datesAttr.SS)) {
      datesList = datesAttr.SS as string[];
    } else if ("L" in datesAttr && Array.isArray(datesAttr.L)) {
      datesList = (datesAttr.L as AttributeValue[])
        .map((v) => (v && "S" in v ? (v.S as string) : null))
        .filter((s): s is string => !!s);
    }
  }
  if (datesList.length > 0) {
    return datesList.every((d) => {
      const jd = new Date(d);
      return !Number.isNaN(jd.getTime()) && jd < today;
    });
  }

  const dateStr = str(item.date) || str(item.start_date) || str(item.startDate);
  if (!dateStr) return false;
  const jobDate = new Date(dateStr);
  if (Number.isNaN(jobDate.getTime())) return false;
  return jobDate < today;
}

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
        ProjectionExpression: "jobId, clinicId, applicationStatus",
        ExclusiveStartKey: lastKey,
      })
    );

    resp.Items?.forEach((item) => {
      const jid = str(item.jobId);
      const cid = str(item.clinicId);
      const status = String(str(item.applicationStatus) || "").toLowerCase();
      // Rejected applications must not exclude the job — the clinic may invite
      // the pro back, and the job has to be applyable again.
      if (status !== "rejected") {
        if (jid) jobIds.add(jid);
      }
      // Familiar-clinic boost stays — prior contact (even a rejection) is still signal.
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
 * Per-signal breakdown of the relevance score. `total` is what sorts; the
 * individual components are surfaced for observability (structured logs in
 * PR 5, and the X-Debug-Ranking response augment for staff JWTs).
 *
 * Components are non-negative except `travelPenalty`, which is subtracted
 * from the total when the soft travel cap fires.
 */
export type ScoreBreakdown = {
  total: number;
  distance: number;
  role: number;
  skills: number;
  recency: number;
  rate: number;
  completeness: number;
  clinicBoost: number;
  popularity: number;
  travelPenalty: number;
};

type ScoreParams = {
  role?: string;
  location?: string;
  distanceMi?: number | null;
  radiusMiles?: number;
  appliedClinicIds?: Set<string>;
  // Profile-derived soft signals. When RANKING_V2_PROFILE_SIGNALS is off the
  // caller passes DEFAULT_PREFERENCES so these are inert.
  profileRole?: string | null;
  profileSpecialties?: string[];
  profileSkills?: string[];
  profileCertificates?: string[];
  profileIsWillingToTravel?: boolean;
  profileMaxTravelDistance?: number | null;
};

// Read once at module init. Lambda env vars are set at deploy time; toggling
// the flag re-runs cold-start which picks the new value up. Reading on every
// score call would be wasteful in hot paths.
const RANKING_V2_SCORE = process.env.RANKING_V2_SCORE === "true";

function roundToTwo(n: number): number {
  return Math.round(n * 100) / 100;
}

function finalize(b: Omit<ScoreBreakdown, "total">): ScoreBreakdown {
  const total = roundToTwo(
    b.distance + b.role + b.skills + b.recency + b.rate +
    b.completeness + b.clinicBoost + b.popularity - b.travelPenalty,
  );
  return { ...b, total };
}

// A scored job carried through the ranker. Defined at module scope so the
// diversity / observability helpers below can name it without taking the
// type as a generic parameter.
type RankedJob = {
  item: Record<string, AttributeValue>;
  score: ScoreBreakdown;
  distanceMi?: number | null;
};

// Returned by the non-trending sort paths (newest / highestPay / priority)
// where we want a uniformly shaped score field but the actual ordering is
// driven by other criteria. Allocating a fresh object per call is fine — the
// ranker runs O(scanned-rows) times, and the row's filter gauntlet dwarfs this.
function emptyBreakdown(): ScoreBreakdown {
  return {
    total: 0, distance: 0, role: 0, skills: 0, recency: 0,
    rate: 0, completeness: 0, clinicBoost: 0, popularity: 0, travelPenalty: 0,
  };
}

// Names of the additive signal components, used for "signal coverage" — how
// many signals contributed something to the total. `travelPenalty` is excluded
// because it's a subtraction; coverage measures contribution, not presence.
const POSITIVE_SIGNAL_KEYS = [
  "distance", "role", "skills", "recency", "rate",
  "completeness", "clinicBoost", "popularity",
] as const;

const RANKING_V2_DIVERSITY = process.env.RANKING_V2_DIVERSITY === "true";

/**
 * Reorder a page of ranked jobs so no clinic occupies more than 2 consecutive
 * slots. When a 3rd-in-a-row collision is detected, the offending row is
 * swapped forward with the nearest later row from a different clinic. The
 * swap is bounded by the page itself, so worst-case work is O(page²) — fine
 * for the page sizes the dashboard ever requests (20-50).
 *
 * Promoted bucket is intentionally untouched — paid placement keeps its slot.
 */
function diversifyByClinic(jobs: RankedJob[]): RankedJob[] {
  if (!RANKING_V2_DIVERSITY || jobs.length <= 2) return jobs;
  const result = [...jobs];
  for (let i = 2; i < result.length; i++) {
    const cid = str(result[i].item.clinicId);
    if (!cid) continue;
    const prev1 = str(result[i - 1].item.clinicId);
    const prev2 = str(result[i - 2].item.clinicId);
    if (prev1 !== cid || prev2 !== cid) continue;
    // 3rd-in-a-row from the same clinic — find the nearest later row from a
    // different clinic and swap. If none exists (whole tail belongs to this
    // clinic), leave the cluster — there's nothing useful to swap with.
    for (let j = i + 1; j < result.length; j++) {
      const ocid = str(result[j].item.clinicId);
      if (ocid && ocid !== cid) {
        const tmp = result[i];
        result[i] = result[j];
        result[j] = tmp;
        break;
      }
    }
  }
  return result;
}

type RankedJobLite = { item: Record<string, AttributeValue>; score: ScoreBreakdown };

/**
 * Compute "signal coverage" — the fraction of additive ranking signals that
 * contributed a non-zero value to the total. Useful as a single-number health
 * check for the ranker: if coverage collapses to recency+completeness only,
 * personalisation has stopped flowing through.
 */
function signalCoverage(items: RankedJobLite[]): number {
  if (items.length === 0) return 0;
  const active = new Set<string>();
  for (const it of items) {
    for (const k of POSITIVE_SIGNAL_KEYS) {
      if (it.score[k] > 0) active.add(k);
    }
  }
  return active.size / POSITIVE_SIGNAL_KEYS.length;
}

/**
 * Emit a structured ranking observability line. The `_aws` envelope is
 * CloudWatch's Embedded Metric Format — when this lambda's log group is
 * configured for EMF, CloudWatch automatically extracts `RankingSignalCoverage`
 * as a metric. The same line doubles as a human-readable log entry so the
 * data is useful without any CloudWatch setup.
 */
function emitRankingLog(payload: {
  userSub: string;
  coordSource: "live" | "stored" | "none";
  totalScanned: number;
  matchedCount: number;
  promotedCount: number;
  topJobs: { jobId: string; total: number; breakdown: ScoreBreakdown }[];
  coverage: number;
}) {
  const line = {
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: "DentiPal/Ranking",
        Dimensions: [["FeedKind"]],
        Metrics: [{ Name: "RankingSignalCoverage", Unit: "None" }],
      }],
    },
    FeedKind: "available",
    RankingSignalCoverage: payload.coverage,
    event: "ranking",
    userSub: payload.userSub,
    coordSource: payload.coordSource,
    totalScanned: payload.totalScanned,
    matchedCount: payload.matchedCount,
    promotedCount: payload.promotedCount,
    topJobs: payload.topJobs,
  };
  // Single-line JSON keeps Cloud Watch Logs Insights queries trivial.
  console.log(JSON.stringify(line));
}

/**
 * Compute the relevance score for a job. Returns a breakdown rather than a
 * scalar so the per-signal contribution is available for logging and debug.
 * Dispatches to V1 (current weights) or V2 (rebalanced weights with
 * always-on distance + skill overlap + soft travel cap) based on
 * RANKING_V2_SCORE env flag.
 */
function computeRelevanceScore(
  job: Record<string, AttributeValue>,
  params: ScoreParams,
): ScoreBreakdown {
  return RANKING_V2_SCORE ? computeScoreV2(job, params) : computeScoreV1(job, params);
}

/**
 * Legacy weights — preserved for the canary off-state. Max ≈ 140.
 * Recency 40 / Role 30 / Rate 20 / Completeness 10 / Distance 10 /
 * ClinicBoost 15 / Popularity 15.
 */
function computeScoreV1(job: Record<string, AttributeValue>, params: ScoreParams): ScoreBreakdown {
  let recency = 0;
  const createdAt = str(job.createdAt);
  if (createdAt) {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    recency = Math.max(0, 40 * (1 - ageDays / 30));
  }

  // Role match — filter takes priority, falls back to profile role; specialty
  // overlap adds up to +10 within the same 30-point ceiling.
  const effectiveRole = params.role || params.profileRole || "";
  let role = 0;
  if (effectiveRole) {
    const jobRole = (str(job.professional_role) || str(job.professionalRole)).toLowerCase();
    const filterRole = effectiveRole.toLowerCase();
    if (jobRole === filterRole) role = 30;
    else if (jobRole.includes(filterRole) || filterRole.includes(jobRole)) role = 15;
  }
  if (params.profileSpecialties && params.profileSpecialties.length > 0) {
    const jobSpec = (str(job.shift_speciality) || str(job.shiftSpeciality)).toLowerCase();
    if (jobSpec) {
      const overlap = params.profileSpecialties.some((s) => {
        const ls = s.toLowerCase();
        return ls === jobSpec || jobSpec.includes(ls) || ls.includes(jobSpec);
      });
      if (overlap) role = Math.min(30, role + 10);
    }
  }

  const rateValue = num(job.rate) ?? num(job.hourly_rate) ?? num(job.hourlyRate) ?? 0;
  const rate = Math.min(20, (rateValue / 200) * 20);

  let completeness = 0;
  if (str(job.date) || job.dates) completeness += 2.5;
  if (str(job.start_time) || str(job.startTime)) completeness += 2.5;
  if (str(job.professional_role) || str(job.professionalRole)) completeness += 2.5;
  if (rateValue > 0) completeness += 2.5;

  let distance = 0;
  if (params.distanceMi != null && params.radiusMiles && params.radiusMiles > 0) {
    distance = Math.max(0, 10 * (1 - params.distanceMi / params.radiusMiles));
  }

  let clinicBoost = 0;
  if (params.appliedClinicIds && params.appliedClinicIds.size > 0) {
    const jobClinicId = str(job.clinicId);
    if (jobClinicId && params.appliedClinicIds.has(jobClinicId)) clinicBoost = 15;
  }

  let popularity = 0;
  const apps = num(job.applicationsCount) ?? 0;
  if (apps > 0) popularity = Math.min(15, Math.log(1 + apps) * 5);

  return finalize({
    distance, role, skills: 0, recency, rate, completeness,
    clinicBoost, popularity, travelPenalty: 0,
  });
}

/**
 * V2 weights — recency capped lower so distance/role can compete. Max ≈ 160.
 * Distance 40 (exp decay scaled by profile.maxTravelDistance) /
 * Role 30 / Skills 15 / Recency 25 / Rate 15 / Completeness 10 /
 * ClinicBoost 15 / Popularity 10. Soft travel penalty: -20 when the pro
 * declared `is_willing_to_travel = false` and the job is non-permanent
 * outside their declared max distance.
 */
function computeScoreV2(job: Record<string, AttributeValue>, params: ScoreParams): ScoreBreakdown {
  // Distance — exponential decay so a 5mi job scores ~5x a 25mi job for a
  // typical pro. Scale derived from the pro's declared travel reach: a pro
  // willing to travel 50mi gets a flatter curve (broader catchment) than one
  // willing to travel 10mi. The 15-mile floor keeps the curve sane for pros
  // with very low or unset max_travel_distance.
  let distance = 0;
  if (params.distanceMi != null) {
    const scale = Math.max(15, (params.profileMaxTravelDistance ?? 30) / 2);
    distance = 40 * Math.exp(-params.distanceMi / scale);
  }

  // Role match — same shape as V1 but consumed alongside skills below.
  const effectiveRole = params.role || params.profileRole || "";
  let role = 0;
  if (effectiveRole) {
    const jobRole = (str(job.professional_role) || str(job.professionalRole)).toLowerCase();
    const filterRole = effectiveRole.toLowerCase();
    if (jobRole === filterRole) role = 30;
    else if (jobRole.includes(filterRole) || filterRole.includes(jobRole)) role = 15;
  }
  if (params.profileSpecialties && params.profileSpecialties.length > 0) {
    const jobSpec = (str(job.shift_speciality) || str(job.shiftSpeciality)).toLowerCase();
    if (jobSpec) {
      const overlap = params.profileSpecialties.some((s) => {
        const ls = s.toLowerCase();
        return ls === jobSpec || jobSpec.includes(ls) || ls.includes(jobSpec);
      });
      if (overlap) role = Math.min(30, role + 10);
    }
  }

  // Skill / certificate overlap — +3 per hit against job.requirements, capped
  // at 15. Skills and certs share the same cap so a pro with both doesn't
  // double-count the same job text.
  let skills = 0;
  const requirementsText = (str(job.requirements) || "").toLowerCase();
  if (requirementsText) {
    const tokens = new Set<string>();
    for (const s of params.profileSkills || []) {
      const ls = s.toLowerCase().trim();
      if (ls) tokens.add(ls);
    }
    for (const c of params.profileCertificates || []) {
      const lc = c.toLowerCase().trim();
      if (lc) tokens.add(lc);
    }
    let hits = 0;
    for (const t of tokens) {
      if (requirementsText.includes(t)) hits++;
      if (hits * 3 >= 15) break;
    }
    skills = Math.min(15, hits * 3);
  }

  // Recency — same linear-over-30-days curve, lower ceiling so other signals
  // can compete instead of being drowned out.
  let recency = 0;
  const createdAt = str(job.createdAt);
  if (createdAt) {
    const ageDays = (Date.now() - new Date(createdAt).getTime()) / (1000 * 60 * 60 * 24);
    recency = Math.max(0, 25 * (1 - ageDays / 30));
  }

  const rateValue = num(job.rate) ?? num(job.hourly_rate) ?? num(job.hourlyRate) ?? 0;
  const rate = Math.min(15, (rateValue / 200) * 15);

  let completeness = 0;
  if (str(job.date) || job.dates) completeness += 2.5;
  if (str(job.start_time) || str(job.startTime)) completeness += 2.5;
  if (str(job.professional_role) || str(job.professionalRole)) completeness += 2.5;
  if (rateValue > 0) completeness += 2.5;

  let clinicBoost = 0;
  if (params.appliedClinicIds && params.appliedClinicIds.size > 0) {
    const jobClinicId = str(job.clinicId);
    if (jobClinicId && params.appliedClinicIds.has(jobClinicId)) clinicBoost = 15;
  }

  let popularity = 0;
  const apps = num(job.applicationsCount) ?? 0;
  if (apps > 0) popularity = Math.min(10, Math.log(1 + apps) * 3.3);

  // Soft travel cap — penalty only, not exclusion. Permanent roles often
  // involve relocation, so they're exempt; the pro might still want a great
  // distant permanent match. For temporary/consulting work, declared "not
  // willing to travel" beyond the declared max costs -20 points.
  let travelPenalty = 0;
  const jobType = (str(job.job_type) || str(job.jobType)).toLowerCase();
  const isPermanent = jobType === "permanent";
  if (
    params.profileIsWillingToTravel === false &&
    !isPermanent &&
    params.distanceMi != null &&
    params.profileMaxTravelDistance != null &&
    params.distanceMi > params.profileMaxTravelDistance
  ) {
    travelPenalty = 20;
  }

  return finalize({
    distance, role, skills, recency, rate, completeness,
    clinicBoost, popularity, travelPenalty,
  });
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
    // Hourly jobs are stored as "per_hour"; tolerate either spelling from the
    // client so both new (per_hour) and legacy (hourly) filter values work,
    // and treat jobs with no pay_type as hourly (default).
    if (filters.payType === "per_hour" || filters.payType === "hourly") {
      if (jpt && jpt !== "per_hour" && jpt !== "hourly") return false;
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
  const method = (event.requestContext as any)?.http?.method || event.httpMethod || "GET";

  if (method === "OPTIONS")
    return { statusCode: 204, headers: corsHeaders(event), body: "" };
  if (method !== "GET") return json(event, 405, { error: "Method not allowed" });

  let userSub: string | undefined;
  try {
    const authHeader = event.headers?.Authorization || event.headers?.authorization;
    if (!authHeader) return json(event, 401, { error: "Missing Authorization header" });
    userSub = extractUserFromBearerToken(authHeader).sub;
    if (!userSub) return json(event, 401, { error: "User sub missing in token" });
  } catch (e: any) {
    return json(event, 401, { error: "Unauthorized", reason: e?.message });
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
    // Coords are resolved whenever the pro hasn't supplied a live override,
    // because the promoted-job 50-mile relevance gate needs them even when the
    // pro hasn't opted into an organic radius filter.
    const needStoredCoords = !liveUserCoords;
    const isFirstPage = !cursor;
    // Phase 2: also fetch the pro's "scheduled" job occurrences so the feed
    // can hide anything that time-conflicts with what they're already booked.
    // Parallel with the existing fetches — adds one query, no serial cost.
    // Profile preference slice (role / specialties / skills / certs / travel
    // prefs) is fetched on every request. The data only influences ranking
    // when RANKING_V2_PROFILE_SIGNALS is enabled, but the read is unconditional
    // so the parallel-load shape stays stable and the flag flip is purely
    // a scoring change with no extra round-trip.
    const [appliedInfo, storedCoords, promotedItems, availability, scheduledOccurrences, preferences] = await Promise.all([
      getAppliedJobInfo(userSub),
      needStoredCoords ? getProfessionalCoords(userSub) : Promise.resolve(null as Coordinates | null),
      isFirstPage ? getActivePromotedJobItems() : Promise.resolve([] as Record<string, AttributeValue>[]),
      getProfessionalAvailability(userSub),
      getScheduledOccurrences(userSub),
      getProfessionalPreferences(userSub),
    ]);

    const profileSignalsEnabled = process.env.RANKING_V2_PROFILE_SIGNALS === "true";
    const activePreferences: ProfessionalPreferences = profileSignalsEnabled
      ? preferences
      : DEFAULT_PREFERENCES;

    // Master availability gate — when the pro flips the toggle OFF we surface
    // an empty feed (no jobs, no promoted slots) but keep the response shape
    // so the UI's loading/empty states still render. Scheduled-shifts and
    // applications endpoints are intentionally untouched: the pro must still
    // see jobs they're already committed to.
    if (!availability.isAvailableForJobs) {
      return json(event, 200, {
        totalJobs: 0,
        totalMatched: 0,
        hasMore: false,
        nextCursor: null,
        jobs: [],
        promotedJobs: [],
        counts: { temporary: 0, multiday: 0, permanent: 0 },
        countsTruncated: false,
        availability: { isAvailableForJobs: false, availableDays: [] },
      });
    }

    const appliedJobIds = appliedInfo.jobIds;
    const appliedClinicIds = appliedInfo.clinicIds;

    const profCoords: Coordinates | null = liveUserCoords ?? storedCoords;
    console.log(`Excluding ${appliedJobIds.size} applied jobs. Boost: ${appliedClinicIds.size} familiar clinics. Radius: ${radiusMiles ?? "none"}, source: ${liveUserCoords ? "live browser" : storedCoords ? "saved profile" : "none"}, coords: ${profCoords ? `(${profCoords.lat}, ${profCoords.lng})` : "none"}`);

    // 2) Query the status-createdAt GSI for "open" jobs, newest first
    //    Falls back to scanning "active" status if "open" yields nothing
    const statusesToQuery = ["open", "active"];
    let matchedJobs: RankedJob[] = [];
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
        return json(event, 400, { error: "Invalid cursor" });
      }
    }

    // The cursor is a DynamoDB LastEvaluatedKey from the status-createdAt-index GSI.
    // Its `status` attribute is the GSI partition key — DynamoDB will reject the query
    // if we hand this key to a KeyConditionExpression whose status doesn't match.
    // So: figure out which status the cursor came from, and resume iteration there.
    const cursorStatus = exclusiveStartKey?.status?.S;
    if (cursorStatus && !statusesToQuery.includes(cursorStatus)) {
      return json(event, 400, { error: "Invalid cursor" });
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

          // Skip jobs whose scheduled date(s) are all in the past — those
          // can't be applied to so they must not appear in the pro's feed
          // or in any of the counts.
          if (isJobFullyPast(item)) continue;

          // Phase 1: everything except jobType
          if (!matchesFilters(item, filtersSansJobType)) continue;

          // Weekday gate from the pro's Availability section. Empty day list →
          // no filter; otherwise the job's date(s) must hit at least one of
          // the selected weekdays.
          if (!jobMatchesWeekdays(item, availability.availableDays)) continue;

          // ---- Phase 2 gates (additive — each is a no-op when the pro
          // hasn't filled in the corresponding setting). Order matters only
          // for clarity; any one rejection drops the job.
          //
          // (a) Blocked dates — exact YYYY-MM-DD match wins over weekday.
          const occDates = jobDates(item);
          let blockedByDate = false;
          for (const d of occDates) {
            if (dateIsBlocked(d, availability.unavailableDates)) { blockedByDate = true; break; }
          }
          if (blockedByDate) continue;

          // (b) Schedule-conflict — same day + overlapping time as something
          // the pro is already booked for.
          if (jobConflictsWithScheduled(item, scheduledOccurrences)) continue;

          // Distance computation is now decoupled from the radius filter.
          //
          // - When `profCoords` exists (live geo > stored address), we compute
          //   `distanceMi` for every job that has coords. The V2 score uses this
          //   for its exponential decay term, so distance influences ranking even
          //   when no explicit `radius` filter is set.
          //
          // - The radius filter is still a hard gate when present: anything beyond
          //   `radiusMiles` is dropped, and jobs missing coords are dropped (we
          //   can't verify they fit). Without a radius filter, missing job coords
          //   simply mean the distance term contributes 0 for that row.
          let distanceMi: number | null = null;
          if (profCoords) {
            const jobCoords = getJobCoords(item);
            if (jobCoords) {
              distanceMi = haversineDistance(profCoords.lat, profCoords.lng, jobCoords.lat, jobCoords.lng);
              if (radiusMiles && distanceMi > radiusMiles) continue;
            } else if (radiusMiles) {
              continue; // radius set but job has no coords → cannot verify → exclude
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
          const score: ScoreBreakdown = sort === "trending"
            ? computeRelevanceScore(item, {
                role: filters.role,
                location: filters.location,
                distanceMi,
                radiusMiles,
                appliedClinicIds,
                profileRole: activePreferences.role,
                profileSpecialties: activePreferences.specialties,
                profileSkills: activePreferences.skills,
                profileCertificates: activePreferences.certificates,
                profileIsWillingToTravel: activePreferences.isWillingToTravel,
                profileMaxTravelDistance: activePreferences.maxTravelDistance,
              })
            : emptyBreakdown();
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

    // 2b) Score promoted jobs through the same filter pipeline + a 50-mile
    //     relevance gate so paid placement doesn't follow a pro across the
    //     country. Promoted matches stay in their own bucket — they no longer
    //     mix into matchedJobs — so the response can deliver two distinct
    //     surfaces (Promoted section vs. organic feed) to the UI.
    //     Promoted entries take priority over organic ones on jobId collision
    //     (the organic scan may surface the same job independently).
    const PROMOTED_RADIUS_MI = 50;
    const promotedMatched: RankedJob[] = [];
    if (promotedItems.length > 0) {
      let droppedOutsideRadius = 0;
      let droppedMissingCoords = 0;

      for (const item of promotedItems) {
        const jobId = str(item.jobId);
        if (!jobId || appliedJobIds.has(jobId)) continue;

        // Only surface jobs that are still open/active (promotion may outlive the job).
        const jobStatus = str(item.status);
        if (jobStatus !== "open" && jobStatus !== "active") continue;

        // Skip past-date jobs even when promoted — a paid boost on a job
        // that's already happened helps nobody and would distort counts.
        if (isJobFullyPast(item)) continue;

        // Soft 50-mile relevance gate. When both the pro and the job are
        // geocoded we enforce the radius — a paid boost in Houston is not
        // relevant to a Dallas pro. When either side lacks coords (common in
        // dev/test environments and for newly-created jobs whose geocoding
        // hasn't completed yet), we surface the promoted job anyway so a paid
        // boost is never silently swallowed by missing metadata.
        const jobCoords = getJobCoords(item);
        let distanceMi: number | null = null;
        if (profCoords && jobCoords) {
          distanceMi = haversineDistance(
            profCoords.lat, profCoords.lng,
            jobCoords.lat, jobCoords.lng,
          );
          if (distanceMi > PROMOTED_RADIUS_MI) { droppedOutsideRadius++; continue; }
        } else {
          droppedMissingCoords++;
          // Note: counter is incremented but we DO NOT `continue` — the
          // promotion still surfaces. The log line below uses this counter
          // to flag "X promoted jobs surfaced without coord verification".
        }

        // Two-phase: gate by non-jobType filters first, bucket, then jobType.
        if (!matchesFilters(item, filtersSansJobType)) continue;

        // Weekday gate (same semantics as the organic loop above).
        if (!jobMatchesWeekdays(item, availability.availableDays)) continue;

        // Phase 2 gates — same set as the organic loop. Promoted placements
        // must not break the pro's actual availability rules.
        {
          const occDates = jobDates(item);
          let blocked = false;
          for (const d of occDates) {
            if (dateIsBlocked(d, availability.unavailableDates)) { blocked = true; break; }
          }
          if (blocked) continue;

          if (jobConflictsWithScheduled(item, scheduledOccurrences)) continue;
        }

        // Also honour the user-set radius filter when one is active and is
        // tighter than the promoted gate (e.g. pro restricted feed to 10 mi).
        // Skip this gate when distance is unknown (missing coords) so the
        // promoted slot still surfaces.
        if (radiusMiles && distanceMi !== null && distanceMi > radiusMiles) continue;

        const jt = (str(item.job_type) || str(item.jobType)).toLowerCase();
        if (computeCounts) {
          if (jt === "temporary") counts.temporary++;
          else if (jt === "permanent") counts.permanent++;
          else if (jt === "consulting" || jt === "multi_day_consulting") counts.multiday++;
        }

        if (!itemMatchesSelectedType(jt)) continue;

        // Always compute relevance for promoted jobs (every sort mode) — the
        // promoted section ranks by tier × score regardless of which mode the
        // pro picked for the organic feed.
        const score = computeRelevanceScore(item, {
          role: filters.role,
          location: filters.location,
          distanceMi,
          radiusMiles,
          appliedClinicIds,
          profileRole: activePreferences.role,
          profileSpecialties: activePreferences.specialties,
          profileSkills: activePreferences.skills,
          profileCertificates: activePreferences.certificates,
          profileIsWillingToTravel: activePreferences.isWillingToTravel,
          profileMaxTravelDistance: activePreferences.maxTravelDistance,
        });
        promotedMatched.push({ item, score, distanceMi });
      }

      // Dedupe: if the organic scan surfaced any of the promoted jobs, drop
      // them from the organic bucket so they only appear in the Promoted
      // section. They are no longer merged into matchedJobs.
      if (promotedMatched.length > 0) {
        const promotedIds = new Set(promotedMatched.map((m) => str(m.item.jobId)));
        matchedJobs = matchedJobs.filter((m) => !promotedIds.has(str(m.item.jobId)));
      }

      console.log(`[Promotions] ${promotedMatched.length} promoted jobs surfaced; dropped ${droppedOutsideRadius} outside ${PROMOTED_RADIUS_MI}mi, ${droppedMissingCoords} surfaced without coord verification (missing lat/lng on pro or job).`);
    }

    // 3) Sort organic jobs by the requested mode. Promoted jobs are sorted
    //    separately below — they no longer mix into matchedJobs, so the per-
    //    mode logic here is pure organic ranking with no tier tiebreaker.
    //    "trending"  → relevance score → newest
    //    "newest"    → newest first
    //    "highestPay"→ highest rate first (cursor-paged within current page only)
    //    "priority"  → newest (legacy alias for now)
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

        case "priority":
          return createdAtMs(b.item) - createdAtMs(a.item);

        case "trending":
        default: {
          if (b.score.total !== a.score.total) return b.score.total - a.score.total;
          return createdAtMs(b.item) - createdAtMs(a.item);
        }
      }
    });

    // 3b) Sort promoted jobs by the hybrid (tier × relevance) score so that
    //     a low-tier highly-relevant job can outrank a high-tier irrelevant
    //     one — paid placement still wins surface, but only when the match is
    //     actually useful to the pro. Tiebreak by newest so equal-score
    //     promotions don't shuffle between requests.
    const tierWeightOf = (item: Record<string, AttributeValue>): number => {
      const planId = str(item.promotionPlanId);
      return PROMOTION_TIER_WEIGHT[planId] || 1;
    };
    const hybridScore = (m: RankedJob): number =>
      tierWeightOf(m.item) * m.score.total;

    promotedMatched.sort((a, b) => {
      const diff = hybridScore(b) - hybridScore(a);
      if (diff !== 0) return diff;
      return createdAtMs(b.item) - createdAtMs(a.item);
    });

    // 4) Slice to requested page size, honoring any in-memory offset from an
    //    earlier overflow page.
    //
    //    Diversity rerank runs only on the visible page — reordering jobs
    //    that won't be returned wastes work and risks oscillating between
    //    pages on cursor navigation. The rerank itself is a no-op when
    //    RANKING_V2_DIVERSITY is off.
    const pageJobs = diversifyByClinic(matchedJobs.slice(overflowOffset, overflowOffset + limit));

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
    //
    //    `X-Debug-Ranking: 1` augments each row's `_relevanceScore` with the
    //    full per-signal breakdown so staff can introspect rankings in the
    //    browser devtools. Header-only gate for now — JWT-claim gating
    //    (admin/staff) is a follow-up; the data is non-sensitive (just
    //    score numbers), so cost of accidental exposure is low.
    const debugRanking =
      (event.headers?.["x-debug-ranking"] || event.headers?.["X-Debug-Ranking"]) === "1";
    const toJobObject = ({ item, score, distanceMi }: RankedJob) => {
      const obj: any = {
        ...itemToObject(item),
        _relevanceScore: debugRanking ? score : score.total,
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
    };

    // Organic bucket: strip promotion fields so the badge never renders on
    // organic-positioned cards and clicks/impressions aren't mis-attributed
    // to the promotion. The merchant paid for the Promoted section slot
    // (page-1-only), not for incidental organic appearances on later pages
    // or when a job slipped past the 50-mile promoted-radius gate.
    const jobs = pageJobs.map((entry) => {
      const obj = toJobObject(entry);
      if (obj.isPromoted) {
        obj.isPromoted = false;
        delete obj.promotionId;
        delete obj.promotionPlanId;
        delete obj.promotionExpiresAt;
      }
      return obj;
    });
    // Promoted jobs are page-1-only (gated by isFirstPage above) and capped by
    // the 50-mile relevance radius — the geographic gate replaces a numeric
    // count cap, so we surface every promoted job that qualifies.
    const promotedJobs = promotedMatched.map(toJobObject);

    // 6b) Enrich with clinic display name from CLINIC_PROFILES_TABLE so the
    //     professional UI can show "<role> at <clinic name>" without a second
    //     round-trip from the client.
    //     CLINIC_PROFILES_TABLE has a COMPOSITE PK (clinicId, userSub) — both
    //     are required for BatchGetItem; passing userSub alone raises a silent
    //     ValidationException and the page goes out with no clinic names.
    const allPageJobs = [...jobs, ...promotedJobs] as any[];
    const seenPairs = new Set<string>();
    const keyPairs: { clinicId: string; clinicUserSub: string }[] = [];
    for (const j of allPageJobs) {
      const clinicId = typeof j.clinicId === "string" ? j.clinicId : "";
      const clinicUserSub = typeof j.clinicUserSub === "string" ? j.clinicUserSub : "";
      if (!clinicId || !clinicUserSub) continue;
      const k = `${clinicId}#${clinicUserSub}`;
      if (seenPairs.has(k)) continue;
      seenPairs.add(k);
      keyPairs.push({ clinicId, clinicUserSub });
    }
    if (keyPairs.length > 0) {
      try {
        const clinicNameByPair = new Map<string, string>();
        // BatchGetItem caps at 100 keys per call — chunk to stay safe.
        for (let i = 0; i < keyPairs.length; i += 100) {
          const chunk = keyPairs.slice(i, i + 100);
          const resp = await ddb.send(new BatchGetItemCommand({
            RequestItems: {
              [CLINIC_PROFILES_TABLE]: {
                Keys: chunk.map(({ clinicId, clinicUserSub }) => ({
                  clinicId: { S: clinicId },
                  userSub: { S: clinicUserSub },
                })),
                ProjectionExpression: "clinicId, userSub, clinic_name",
              },
            },
          }));
          for (const row of resp.Responses?.[CLINIC_PROFILES_TABLE] || []) {
            const cid = str(row.clinicId);
            const sub = str(row.userSub);
            const name = str(row.clinic_name);
            if (cid && sub && name) clinicNameByPair.set(`${cid}#${sub}`, name);
          }
        }
        for (const j of allPageJobs) {
          const name = clinicNameByPair.get(`${j.clinicId}#${j.clinicUserSub}`);
          if (name) {
            j.clinicName = name;
            j.clinic = { ...(j.clinic || {}), name };
          }
        }
      } catch (e) {
        console.warn("[clinic name enrichment] failed:", e);
      }
    }

    // Tick impressions for every promoted job we actually surfaced. Organic
    // matches no longer carry an isPromoted flag (the dedupe in step 2b pulled
    // them out of the organic bucket), so this loop is exhaustive.
    for (const j of promotedJobs) {
      if (j.isPromoted && j.jobId && j.promotionId) {
        fireAndForgetIncrement(j.jobId, j.promotionId, "impressions");
      }
    }

    // Structured ranking observability — one EMF line per request, so the
    // CloudWatch metric and the human-readable trace share the same source
    // of truth. Top 5 jobs by score expose the breakdown so we can see
    // *why* the ranker chose this ordering when debugging a feed.
    const coordSource: "live" | "stored" | "none" =
      liveUserCoords ? "live" : storedCoords ? "stored" : "none";
    const topJobs = pageJobs.slice(0, 5).map((m) => ({
      jobId: str(m.item.jobId),
      total: m.score.total,
      breakdown: m.score,
    }));
    emitRankingLog({
      userSub,
      coordSource,
      totalScanned,
      matchedCount: matchedJobs.length,
      promotedCount: promotedMatched.length,
      topJobs,
      coverage: signalCoverage([...pageJobs, ...promotedMatched]),
    });

    return json(event, 200, {
      totalJobs: jobs.length,
      totalMatched,
      hasMore,
      nextCursor,
      jobs,
      // Promoted jobs live in their own bucket so the UI can render them as a
      // distinct "Promoted" section. Only populated on first-page requests
      // (cursor-paged loads return an empty array).
      promotedJobs,
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
    return json(event, 500, {
      error: "Internal Server Error",
      details: err.message,
      stack: process.env.NODE_ENV === "development" ? err.stack : undefined,
    });
  }
};
