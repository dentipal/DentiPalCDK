import {
  DynamoDBClient,
  QueryCommand,
  AttributeValue,
} from "@aws-sdk/client-dynamodb";

// Helper layer used by job-feed, job-application, and clinic-discovery handlers
// to honour the pro's Availability settings.
//
// Phase 1 storage on PROFESSIONAL_PROFILES_TABLE:
//   - is_available_for_jobs: BOOL  (master toggle)
//   - available_days: SS           (weekday list, e.g. ["Monday","Wednesday"])
//
// Phase 2 storage (additive):
//   - available_time_slots: S      (JSON string: {day: [{start,end}]} in 24h HH:MM)
//   - unavailable_dates:    SS     (YYYY-MM-DD strings the pro is blocked on)
//
// Phase 2 commitments come from JOB_APPLICATIONS_TABLE rows whose
// applicationStatus is "scheduled" — written by acceptProf when a clinic hires.
//
// Legacy rows missing any of these attributes inherit the most permissive
// default so the rollout never silently breaks an existing pro.

const REGION = process.env.REGION || "us-east-1";
const PROFESSIONAL_PROFILES_TABLE = process.env.PROFESSIONAL_PROFILES_TABLE || "";
const JOB_APPLICATIONS_TABLE = process.env.JOB_APPLICATIONS_TABLE || "DentiPal-V5-JobApplications";

const ddb = new DynamoDBClient({ region: REGION });

export interface TimeWindow {
  start: string; // "HH:MM" 24-hour
  end: string;   // "HH:MM" 24-hour
}

export type AvailableTimeSlots = Partial<Record<string, TimeWindow[]>>;

export interface ProfessionalAvailability {
  isAvailableForJobs: boolean;
  // Empty array means "no weekday restriction — match any day".
  availableDays: string[];
  // Empty map (or missing day key) means "no time restriction for that day".
  availableTimeSlots: AvailableTimeSlots;
  // YYYY-MM-DD list of blocked dates.
  unavailableDates: string[];
}

export const DEFAULT_AVAILABILITY: ProfessionalAvailability = {
  isAvailableForJobs: true,
  availableDays: [],
  availableTimeSlots: {},
  unavailableDates: [],
};

const WEEKDAY_BY_INDEX = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/**
 * Read availability fields off any DynamoDB profile item. Used both by the
 * direct lookup below and by other handlers that already scanned the profile
 * row and want to avoid a second round-trip.
 */
export function readAvailabilityFromProfileItem(
  item: Record<string, AttributeValue> | undefined | null,
): ProfessionalAvailability {
  if (!item) return DEFAULT_AVAILABILITY;

  // Default ON: legacy profiles (predating this feature) have no attribute and
  // must remain visible until the pro explicitly opts out.
  const isAvailableForJobs =
    typeof item.is_available_for_jobs?.BOOL === "boolean"
      ? item.is_available_for_jobs.BOOL
      : true;

  const daysAttr = item.available_days;
  let availableDays: string[] = [];
  if (daysAttr) {
    if (Array.isArray(daysAttr.SS)) {
      availableDays = daysAttr.SS.filter((d): d is string => typeof d === "string");
    } else if (Array.isArray(daysAttr.L)) {
      availableDays = daysAttr.L
        .map((v) => (v && typeof v.S === "string" ? v.S : null))
        .filter((v): v is string => v !== null);
    }
  }

  // Phase 2: parse the JSON-stringified time-slot map. Defensive — malformed
  // / legacy values fall back to "no time restriction" rather than failing.
  let availableTimeSlots: AvailableTimeSlots = {};
  const slotsRaw = item.available_time_slots?.S;
  if (slotsRaw && slotsRaw.length > 0) {
    try {
      const parsed = JSON.parse(slotsRaw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [day, windows] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(windows)) continue;
          const cleaned: TimeWindow[] = [];
          for (const w of windows) {
            if (
              w &&
              typeof w === "object" &&
              typeof (w as { start?: unknown }).start === "string" &&
              typeof (w as { end?: unknown }).end === "string"
            ) {
              cleaned.push({
                start: (w as TimeWindow).start,
                end: (w as TimeWindow).end,
              });
            }
          }
          if (cleaned.length > 0) availableTimeSlots[day] = cleaned;
        }
      }
    } catch {
      // Bad JSON → treat as "no time restriction". The validator on the write
      // path prevents this on new writes; old rows fall back gracefully.
    }
  }

  // Phase 2: blocked dates. SS today, but tolerate L for forward compat.
  const datesAttr = item.unavailable_dates;
  let unavailableDates: string[] = [];
  if (datesAttr) {
    if (Array.isArray(datesAttr.SS)) {
      unavailableDates = datesAttr.SS.filter((d): d is string => typeof d === "string");
    } else if (Array.isArray(datesAttr.L)) {
      unavailableDates = datesAttr.L
        .map((v) => (v && typeof v.S === "string" ? v.S : null))
        .filter((v): v is string => v !== null);
    }
  }

  return { isAvailableForJobs, availableDays, availableTimeSlots, unavailableDates };
}

/**
 * Look up the pro's availability by userSub. Falls back to the default
 * (available, no day filter) on any miss or error so a transient DDB issue
 * never makes the pro disappear from the feed.
 */
export async function getProfessionalAvailability(
  userSub: string,
): Promise<ProfessionalAvailability> {
  if (!userSub || !PROFESSIONAL_PROFILES_TABLE) return DEFAULT_AVAILABILITY;
  try {
    const resp = await ddb.send(
      new QueryCommand({
        TableName: PROFESSIONAL_PROFILES_TABLE,
        KeyConditionExpression: "userSub = :userSub",
        ExpressionAttributeValues: { ":userSub": { S: userSub } },
        ProjectionExpression: "is_available_for_jobs, available_days, available_time_slots, unavailable_dates",
        Limit: 1,
      }),
    );
    return readAvailabilityFromProfileItem(resp.Items?.[0]);
  } catch (err) {
    console.warn(
      `[availability] Failed to read availability for ${userSub}; defaulting to available:`,
      (err as Error).message,
    );
    return DEFAULT_AVAILABILITY;
  }
}

/**
 * Return the canonical weekday name for an ISO-like date string ("YYYY-MM-DD"
 * or any string Date can parse). Returns null when unparseable.
 */
export function dateToWeekday(date: string | undefined | null): string | null {
  if (!date) return null;
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return WEEKDAY_BY_INDEX[d.getDay()];
}

/**
 * Decide whether a job posting matches the pro's weekday availability.
 * - If the pro has no day filter (empty list), every job matches.
 * - Temporary jobs: match if their single `date` weekday is selected.
 * - Multi-day consulting: match if ANY date in `dates` falls on a selected weekday.
 * - Permanent / open-ended jobs (no date at all): match (the pro decides per-shift).
 */
export function jobMatchesWeekdays(
  jobItem: Record<string, AttributeValue>,
  availableDays: string[],
): boolean {
  if (availableDays.length === 0) return true;

  const days = new Set(availableDays);

  // Collect every dated occurrence the job advertises.
  const candidateDates: string[] = [];
  if (jobItem.date?.S) candidateDates.push(jobItem.date.S);
  if (jobItem.start_date?.S) candidateDates.push(jobItem.start_date.S);
  if (jobItem.startDate?.S) candidateDates.push(jobItem.startDate.S);
  const datesAttr = jobItem.dates;
  if (datesAttr) {
    if (Array.isArray(datesAttr.SS)) candidateDates.push(...datesAttr.SS);
    else if (Array.isArray(datesAttr.L)) {
      for (const v of datesAttr.L) if (v?.S) candidateDates.push(v.S);
    }
  }

  // No dates at all → open-ended posting (typical for permanent roles). Match.
  if (candidateDates.length === 0) return true;

  for (const d of candidateDates) {
    const wd = dateToWeekday(d);
    if (wd && days.has(wd)) return true;
  }
  return false;
}

// ===========================================================================
// Phase 2: time-window matching, blocked-date check, scheduled-job conflicts
// ===========================================================================

/**
 * Convert "HH:MM" → minutes-since-midnight. Returns null for unparseable
 * input so the caller can decide whether to skip or pass-through.
 */
function timeToMinutes(value: string | undefined | null): number | null {
  if (!value || typeof value !== "string") return null;
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * True if the YYYY-MM-DD date is in the pro's blocked list. Tolerates
 * mixed-case / whitespace by trimming before comparing.
 */
export function dateIsBlocked(date: string | undefined | null, blocked: string[]): boolean {
  if (!date || blocked.length === 0) return false;
  return blocked.includes(date.trim());
}

/**
 * Extract every dated occurrence for a job posting (temporary / multi-day /
 * permanent). Returns YYYY-MM-DD-ish strings in the same shape they were
 * stored — the caller normalizes/parses as needed.
 */
export function jobDates(jobItem: Record<string, AttributeValue>): string[] {
  const out: string[] = [];
  if (jobItem.date?.S) out.push(jobItem.date.S);
  if (jobItem.start_date?.S) out.push(jobItem.start_date.S);
  if (jobItem.startDate?.S) out.push(jobItem.startDate.S);
  const datesAttr = jobItem.dates;
  if (datesAttr) {
    if (Array.isArray(datesAttr.SS)) out.push(...datesAttr.SS);
    else if (Array.isArray(datesAttr.L)) {
      for (const v of datesAttr.L) if (v?.S) out.push(v.S);
    }
  }
  return out;
}

/**
 * Pull start_time/end_time off a job posting in either snake or camel case.
 * Returns nulls when the job has no time fields (e.g. open-ended permanent).
 */
export function jobTimeRange(jobItem: Record<string, AttributeValue>): { start: string | null; end: string | null } {
  const start = jobItem.start_time?.S || jobItem.startTime?.S || null;
  const end = jobItem.end_time?.S || jobItem.endTime?.S || null;
  return { start, end };
}

/**
 * True if the job's time range is fully inside at least one of the pro's
 * windows for the given weekday. Used as the per-day time filter in Phase 2.
 *
 * - No windows for that day → "no restriction" → match.
 * - Job has no time fields → match (open-ended posting; pro decides per shift).
 * - Otherwise: requires jobStart >= windowStart AND jobEnd <= windowEnd for
 *   at least one window. We intentionally require *full containment* rather
 *   than overlap so the pro never gets a job that runs past their stated end.
 */
export function jobTimeMatchesWindows(
  jobItem: Record<string, AttributeValue>,
  weekday: string,
  slots: AvailableTimeSlots,
): boolean {
  const windows = slots[weekday];
  if (!windows || windows.length === 0) return true;

  const { start, end } = jobTimeRange(jobItem);
  const jobStart = timeToMinutes(start);
  const jobEnd = timeToMinutes(end);
  if (jobStart === null || jobEnd === null) return true;

  for (const w of windows) {
    const ws = timeToMinutes(w.start);
    const we = timeToMinutes(w.end);
    if (ws === null || we === null) continue;
    if (jobStart >= ws && jobEnd <= we) return true;
  }
  return false;
}

/**
 * Compact representation of a job the pro is already committed to.
 * date is YYYY-MM-DD; start/end are HH:MM 24-hour or null (open-ended jobs).
 */
export interface ScheduledOccurrence {
  jobId: string;
  date: string;
  start: string | null;
  end: string | null;
}

/**
 * Fetch every job the pro is currently scheduled for and flatten multi-day
 * postings into per-date occurrences so the overlap check stays simple.
 *
 * Returns [] on any miss / error so a transient DDB blip doesn't lock the pro
 * out of new opportunities.
 */
export async function getScheduledOccurrences(userSub: string): Promise<ScheduledOccurrence[]> {
  if (!userSub) return [];
  const occurrences: ScheduledOccurrence[] = [];
  const JOB_POSTINGS_TABLE = process.env.JOB_POSTINGS_TABLE || "DentiPal-JobPostings";

  try {
    // Step 1: list the pro's "scheduled" applications. We use the same GSI as
    // getAppliedJobInfo so we don't pay for a second index design.
    let lastKey: Record<string, AttributeValue> | undefined;
    const scheduledJobIds: string[] = [];
    do {
      const resp = await ddb.send(new QueryCommand({
        TableName: JOB_APPLICATIONS_TABLE,
        IndexName: "professionalUserSub-index",
        KeyConditionExpression: "professionalUserSub = :sub",
        ExpressionAttributeValues: { ":sub": { S: userSub } },
        ProjectionExpression: "jobId, applicationStatus",
        ExclusiveStartKey: lastKey,
      }));
      for (const item of resp.Items || []) {
        if ((item.applicationStatus?.S || "").toLowerCase() === "scheduled" && item.jobId?.S) {
          scheduledJobIds.push(item.jobId.S);
        }
      }
      lastKey = resp.LastEvaluatedKey;
    } while (lastKey);

    if (scheduledJobIds.length === 0) return [];

    // Step 2: look up each scheduled job's date/time. We use the jobId GSI
    // already used elsewhere (createJobApplication/sendJobInvitations use
    // jobId-index-1). One Query per jobId is fine: the typical pro has a
    // small handful of scheduled jobs, and we cap below.
    const CAP = 100;
    for (const jobId of scheduledJobIds.slice(0, CAP)) {
      try {
        const q = await ddb.send(new QueryCommand({
          TableName: JOB_POSTINGS_TABLE,
          IndexName: "jobId-index-1",
          KeyConditionExpression: "jobId = :jid",
          ExpressionAttributeValues: { ":jid": { S: jobId } },
          Limit: 1,
        }));
        const item = q.Items?.[0];
        if (!item) continue;
        const { start, end } = jobTimeRange(item);
        for (const d of jobDates(item)) {
          if (!d) continue;
          occurrences.push({ jobId, date: d, start, end });
        }
      } catch (err) {
        console.warn(`[availability] could not load scheduled job ${jobId}:`, (err as Error).message);
      }
    }
  } catch (err) {
    console.warn(`[availability] failed to list scheduled occurrences for ${userSub}:`, (err as Error).message);
    return [];
  }

  return occurrences;
}

/**
 * Standard half-open interval overlap. Two ranges overlap iff each starts
 * before the other ends. Equal-edge (one job ends exactly when the next
 * starts) is NOT an overlap — back-to-back shifts are fine.
 */
function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Check if a candidate job collides with any of the pro's scheduled
 * occurrences. The "Existing scheduled job: 18 May 10:00–12:00, hide
 * 9:30–11:00 etc." rule in the spec.
 *
 * Strategy:
 *   - For each job-date × scheduled-date pair on the same calendar day:
 *       - If either side has no times → treat as full-day conflict on that
 *         date (the safer answer; the pro will see the existing scheduled job
 *         in their schedule and can manually adjust).
 *       - Otherwise run a half-open interval overlap on minutes-since-midnight.
 */
export function jobConflictsWithScheduled(
  jobItem: Record<string, AttributeValue>,
  scheduled: ScheduledOccurrence[],
): boolean {
  if (scheduled.length === 0) return false;

  const dates = jobDates(jobItem);
  if (dates.length === 0) return false; // open-ended posting; nothing to conflict with

  const { start, end } = jobTimeRange(jobItem);
  const jobStart = timeToMinutes(start);
  const jobEnd = timeToMinutes(end);

  for (const date of dates) {
    if (!date) continue;
    for (const occ of scheduled) {
      if (occ.date !== date) continue;
      // Same calendar day. Decide overlap.
      const occStart = timeToMinutes(occ.start);
      const occEnd = timeToMinutes(occ.end);
      const eitherUntimed =
        jobStart === null || jobEnd === null || occStart === null || occEnd === null;
      if (eitherUntimed) return true; // full-day conflict
      if (rangesOverlap(jobStart, jobEnd, occStart, occEnd)) return true;
    }
  }
  return false;
}

/**
 * Same overlap logic, but evaluating an explicit candidate slot (used by the
 * clinic-side validation in acceptProf / sendJobInvitations, where the
 * caller already knows the date/time and doesn't have a DDB item handy).
 */
export function slotConflictsWithScheduled(
  candidate: { date: string; start: string | null; end: string | null },
  scheduled: ScheduledOccurrence[],
): boolean {
  if (scheduled.length === 0 || !candidate.date) return false;
  const jStart = timeToMinutes(candidate.start);
  const jEnd = timeToMinutes(candidate.end);
  for (const occ of scheduled) {
    if (occ.date !== candidate.date) continue;
    const oStart = timeToMinutes(occ.start);
    const oEnd = timeToMinutes(occ.end);
    if (jStart === null || jEnd === null || oStart === null || oEnd === null) return true;
    if (rangesOverlap(jStart, jEnd, oStart, oEnd)) return true;
  }
  return false;
}

/**
 * The full Phase-2 gate: combines weekday match, blocked-date check,
 * time-window match, and scheduled-job conflict. Used by both the job
 * feed and the application endpoint so the rules can't drift.
 *
 * Returns the *first reason* the job was rejected (for logs/responses), or
 * `null` when the job passes all checks.
 */
export function jobBlockedByAvailability(
  jobItem: Record<string, AttributeValue>,
  availability: ProfessionalAvailability,
  scheduled: ScheduledOccurrence[],
): "off" | "weekday" | "blocked_date" | "time_window" | "conflict" | null {
  if (!availability.isAvailableForJobs) return "off";
  if (!jobMatchesWeekdays(jobItem, availability.availableDays)) return "weekday";

  // Blocked-date check — wins over weekday match.
  for (const d of jobDates(jobItem)) {
    if (dateIsBlocked(d, availability.unavailableDates)) return "blocked_date";
  }

  // Time-window check — for each dated occurrence, the weekday's windows
  // (if any) must contain the job's time range.
  for (const d of jobDates(jobItem)) {
    const wd = dateToWeekday(d);
    if (!wd) continue;
    if (!jobTimeMatchesWindows(jobItem, wd, availability.availableTimeSlots)) {
      return "time_window";
    }
  }

  if (jobConflictsWithScheduled(jobItem, scheduled)) return "conflict";
  return null;
}
