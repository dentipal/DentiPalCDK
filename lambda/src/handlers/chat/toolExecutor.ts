import { AuthContext } from "../utils";
import { haversineDistance } from "../geo";
import { runBrowseJobPostings } from "../browseJobPostings";
import { PROFESSIONAL_ROLES, VALID_ROLE_VALUES } from "../professionalRoles";
import { runGetJobInvitations } from "../getJobInvitations";
// Apply path: both apply_to_job and the legacy confirm_apply_to_job invoke
// createJobApplication.ts in-process — same handler the website's POST
// /applications route hits — so chat-side and web-side writes are
// byte-identical (same DDB writes, same defaults). No HTTP involved; we just
// import the handler function and call it via callHandlerInProcess.

// Adapter for un-refactored handlers
import { callHandlerInProcess } from "./handlerAdapter";
import { handler as createJobApplicationHandler } from "../createJobApplication"; // REST apply (NOT the -prof variant)
import { handler as getJobPostingHandler } from "../getJobPosting";
import { handler as getProfessionalFilteredJobsHandler } from "../getProfessionalFilteredJobs";
import { handler as getJobApplicationsHandler } from "../getJobApplications";
import { handler as getAllNegotiationsProfHandler } from "../getAllNegotiations-Prof";
import { handler as getScheduledShiftsHandler } from "../getScheduledShifts";
import { handler as getCompletedShiftsHandler } from "../getCompletedShifts";
import { handler as respondToInvitationHandler } from "../respondToInvitation";
import { handler as deleteJobApplicationHandler } from "../deleteJobApplication";
import { handler as getUsersClinicsHandler } from "../getUsersClinics";
import { handler as getActionNeededHandler } from "../getActionNeeded";
import { handler as getClinicShiftsHandler } from "../getClinicShifts";
import { handler as getJobApplicantsOfAClinicHandler } from "../getJobApplicantsOfAClinic";
import { handler as getPublicProfessionalProfileHandler } from "../getPublicProfessionalProfile";
import { handler as getClinicFavoritesHandler } from "../getClinicFavorites";
import { handler as createTemporaryJobHandler } from "../createTemporaryJob";
import { handler as createMultiDayConsultingHandler } from "../createMultiDayConsulting";
import { handler as createPermanentJobHandler } from "../createPermanentJob";
import { handler as acceptProfHandler } from "../acceptProf";
import { handler as rejectProfHandler } from "../rejectProf";
import { handler as sendJobInvitationsHandler } from "../sendJobInvitations";
// Phase 4 handlers
import { handler as respondToNegotiationHandler } from "../respondToNegotiation";
import { handler as updateCompletedShiftsHandler } from "../updateCompletedShifts";
import { handler as updateProfessionalProfileHandler } from "../updateProfessionalProfile";
import { handler as updateUserAddressHandler } from "../updateUserAddress";
import { handler as updateNotificationPreferencesHandler } from "../updateNotificationPreferences";
import { handler as submitFeedbackHandler } from "../submitFeedback";
import { handler as sendReferralInviteHandler } from "../sendReferralInvite";
import { handler as confirmShiftCompletionHandler } from "../confirmShiftCompletion";
import { handler as reportNoShowHandler } from "../reportNoShow";
import { handler as updateClinicProfileHandler } from "../updateClinicProfile";
import { handler as updateJobPostingHandler } from "../updateJobPosting";
import { handler as updateJobStatusHandler } from "../updateJobStatus";
import { handler as addClinicFavoriteHandler } from "../addClinicFavorite";
import { handler as removeClinicFavoriteHandler } from "../removeClinicFavorite";
import { handler as getAllProfessionalsHandler } from "../getAllProfessionals";
import { handler as createAssignmentHandler } from "../createAssignment";
import { handler as updateAssignmentHandler } from "../updateAssignment";
import { handler as deleteAssignmentHandler } from "../deleteAssignment";

import {
  setPendingPreview,
  clearPendingPreview,
  setRecentSearchResults,
} from "./sessionStore";
import { verifyPreviewBeforeConfirm } from "./previewGate";
import { getToolDefinition } from "./toolSchemas";

export interface ToolCall {
  toolName: string;
  input: Record<string, any>;
  /** Action-group name from the model's returnControl event. Must be echoed
   *  back in the functionResult; otherwise Bedrock rejects the result with
   *  "Unexpected actionGroup". Populated by chatMessage.ts. */
  actionGroup?: string;
}

export interface ToolResultOK { ok: true; toolName: string; data: any; }
export interface ToolResultErr { ok: false; toolName: string; status: number; error: string; }
export type ToolResult = ToolResultOK | ToolResultErr;

const ok = (toolName: string, data: any): ToolResultOK => ({ ok: true, toolName, data });
const err = (toolName: string, status: number, error: string): ToolResultErr => ({ ok: false, toolName, status, error });

/**
 * Convert a handler's response body to a non-empty error-message string.
 * `JSON.stringify(undefined)` returns `undefined` (the JS value, not the
 * string), which when serialized into a WebSocket frame ends up rendering
 * as "Error (undefined)" in the widget. This helper guarantees a usable
 * string even when the underlying handler returned 4xx/5xx with no body.
 */
function safeBodyToString(status: number, body: any): string {
  if (body === undefined || body === null) {
    return `Handler returned ${status} with no body`;
  }
  if (typeof body === "string") return body;
  try {
    const s = JSON.stringify(body);
    return s && s !== "undefined" ? s : `Handler returned ${status} with empty body`;
  } catch {
    return `Handler returned ${status}; body not serializable`;
  }
}

/**
 * Standard "translate adapter result into ToolResult" helper. Use this
 * everywhere instead of inlining `r.status >= 400 ? err(..., JSON.stringify(r.body)) : ok(...)`
 * — `JSON.stringify(undefined)` yields the JS value `undefined`, which
 * surfaces in the widget as `Error (undefined)`. `safeBodyToString` guards
 * against that.
 */
function errOrOk(toolName: string, r: { status: number; body: any }): ToolResult {
  if (r.status >= 400) return err(toolName, r.status, safeBodyToString(r.status, r.body));
  return ok(toolName, r.body);
}

/**
 * Filter the `applications` array inside a getJobApplications response down
 * to a status whitelist. The handler ignores `?status=` so we filter on the
 * way out here — keeps the chat's Scheduled / Completed views aligned with
 * the dashboard's tab filters. Returns a new `{status, body}` whose body
 * mirrors the handler's `{status, statusCode, message, data: {applications, totalCount, ...}, timestamp}`
 * envelope but with the trimmed array.
 */
function filterApplicationsByStatusInResult(
  r: { status: number; body: any },
  allowed: string[],
): { status: number; body: any } {
  if (r.status >= 400 || !r.body || typeof r.body !== "object") return r;
  const allowedSet = new Set(allowed.map((s) => s.toLowerCase()));
  const apps: any[] | undefined =
    r.body?.data?.applications ?? r.body?.applications;
  if (!Array.isArray(apps)) return r;
  const kept = apps.filter((a) => {
    const s = String(a?.applicationStatus || a?.status || "").toLowerCase();
    return allowedSet.has(s);
  });
  const nextBody = { ...r.body };
  if (r.body?.data?.applications) {
    nextBody.data = { ...r.body.data, applications: kept, totalCount: kept.length };
  } else {
    nextBody.applications = kept;
    if ("totalCount" in nextBody) nextBody.totalCount = kept.length;
  }
  return { status: r.status, body: nextBody };
}

/**
 * Server-side filter for `get_open_shifts` (and any sibling shift-list tool).
 * Removes the LLM from the day-of-week / date-range reasoning loop:
 *   - dayOfWeek: "mon" | "monday" | "MON" | ... → restrict to that weekday
 *   - dateFrom / dateTo: inclusive YYYY-MM-DD bounds
 *
 * The shifts handler returns its list in either `body.data.jobPostings`
 * (newer envelope) or `body.jobPostings` (flat) or `body.shifts`. We probe
 * each, filter in place, and rewrite the envelope with an updated count.
 * No-op on error responses or when no filters are supplied.
 */
function filterShiftsByDayAndDateRange(
  r: { status: number; body: any },
  opts: { dayOfWeek?: any; dateFrom?: any; dateTo?: any },
): { status: number; body: any } {
  if (r.status >= 400 || !r.body || typeof r.body !== "object") return r;
  const dow = normalizeDayOfWeek(opts.dayOfWeek);
  const from = typeof opts.dateFrom === "string" ? opts.dateFrom : undefined;
  const to = typeof opts.dateTo === "string" ? opts.dateTo : undefined;
  // If no filters requested, return as-is — pure pass-through.
  if (dow === undefined && !from && !to) return r;

  // Where the array lives in the handler's response. We pick the first
  // matching field; the assignment back uses the same key so the envelope
  // stays consistent. Order matters — probe data.<field> before top.<field>
  // because handlers using the data envelope often also have a flat field
  // alongside it for backwards compat.
  const candidates: Array<["data" | "top", string]> = [
    ["data", "jobPostings"],
    ["data", "shifts"],
    ["data", "applications"],
    ["data", "invitations"],
    ["data", "jobs"],
    ["top", "jobPostings"],
    ["top", "shifts"],
    ["top", "applications"],
    ["top", "invitations"],
    ["top", "jobs"],
  ];
  let arr: any[] | undefined;
  let foundIn: ["data" | "top", string] | undefined;
  for (const [loc, key] of candidates) {
    const at = loc === "data" ? r.body?.data?.[key] : r.body?.[key];
    if (Array.isArray(at)) { arr = at; foundIn = [loc, key]; break; }
  }
  if (!arr || !foundIn) return r;

  const kept = arr.filter((s) => {
    // Applications / invitations carry the shift date one level down inside
    // a `jobPosting` / `job` sub-object — direct rows (job postings, shifts)
    // have it at the top. Probe both layers so this filter works uniformly.
    const date = extractShiftDate(s);
    if (!date) return false; // can't filter rows with no parseable date
    if (from && date < from) return false;
    if (to && date > to) return false;
    if (dow !== undefined) {
      // Construct as local midnight so 'YYYY-MM-DD' doesn't shift across
      // timezones (Date('YYYY-MM-DD') parses as UTC midnight, which can
      // land on the prior day in negative-offset locales). Append T00:00:00.
      const d = new Date(date.length === 10 ? date + "T00:00:00" : date);
      if (Number.isNaN(d.getTime()) || d.getDay() !== dow) return false;
    }
    return true;
  });

  const nextBody = { ...r.body };
  if (foundIn[0] === "data") {
    nextBody.data = { ...r.body.data, [foundIn[1]]: kept };
    if (typeof r.body.data?.totalCount === "number") nextBody.data.totalCount = kept.length;
  } else {
    nextBody[foundIn[1]] = kept;
    if (typeof r.body.totalCount === "number") nextBody.totalCount = kept.length;
  }
  return { status: r.status, body: nextBody };
}

/**
 * Find a shift date inside a row regardless of which list-shape it came
 * from. Probes (first match wins):
 *   - direct fields:   row.date / row.startDate / row.dates[0]
 *   - nested via job:  row.jobPosting.date / .startDate / .dates[0]
 *                      row.job.date / .startDate / .dates[0]
 * Returns undefined if nothing parseable — caller treats that as "exclude
 * this row from filtered output." Better than guessing a default that could
 * silently mis-bucket records.
 */
function extractShiftDate(row: any): string | undefined {
  if (!row || typeof row !== "object") return undefined;
  const probe = (obj: any): string | undefined => {
    if (!obj || typeof obj !== "object") return undefined;
    if (typeof obj.date === "string") return obj.date;
    if (typeof obj.startDate === "string") return obj.startDate;
    if (Array.isArray(obj.dates) && typeof obj.dates[0] === "string") return obj.dates[0];
    return undefined;
  };
  return probe(row) || probe(row.jobPosting) || probe(row.job);
}

/**
 * Map a user-supplied weekday string to a JS Date.getDay() index (0=Sun..6=Sat).
 * Accepts case-insensitive 3-letter abbreviations or full names. Returns
 * undefined for any value we don't recognize so the caller skips the filter
 * rather than producing wrong results.
 */
function normalizeDayOfWeek(v: any): number | undefined {
  if (typeof v !== "string") return undefined;
  const key = v.trim().toLowerCase();
  if (!key) return undefined;
  const map: Record<string, number> = {
    sun: 0, sunday: 0,
    mon: 1, monday: 1,
    tue: 2, tues: 2, tuesday: 2,
    wed: 3, weds: 3, wednesday: 3,
    thu: 4, thur: 4, thurs: 4, thursday: 4,
    fri: 5, friday: 5,
    sat: 6, saturday: 6,
  };
  return key in map ? map[key] : undefined;
}

/**
 * Mirror the dashboard's "Action Needed" filter on the chat side.
 *
 * `getJobApplicantsOfAClinic` (the Lambda behind `list_applicants_for_job`)
 * uses a permissive blacklist — it returns ANYTHING that isn't already
 * accepted/rejected/scheduled/completed/hired/declined/confirmed. That lets
 * `no_show`, `cancelled`, and other terminal-but-not-decided states leak
 * into the chat UI, where they show up as bare info rows without buttons.
 *
 * The dashboard's Action Needed view (`getActionNeeded`) uses a STRICT
 * whitelist: `pending` + `negotiate(ing)` only. Match that here so the chat
 * surfaces exactly the same set of "needs my attention" applicants the
 * dashboard does — no surprises like the no-show that triggered this fix.
 *
 * Walks both the flat `applications` array and the `byJobId` map; drops
 * jobs whose applicant list becomes empty after filtering and updates
 * `totalApplications` / per-job applicant counts accordingly.
 */
const ACTIONABLE_STATUSES = new Set(["pending", "negotiating", "negotiate"]);
function filterApplicantsToActionableInResult(
  r: { status: number; body: any },
): { status: number; body: any } {
  if (r.status >= 400 || !r.body || typeof r.body !== "object") return r;
  const data = r.body?.data;
  if (!data || typeof data !== "object") return r;

  const isActionable = (a: any): boolean => {
    const s = String(a?.application?.applicationStatus || a?.application?.status ||
      a?.applicationStatus || a?.status || "").toLowerCase();
    return ACTIONABLE_STATUSES.has(s);
  };

  // Flat list (applicationsFlat in the handler).
  const flat: any[] = Array.isArray(data.applications) ? data.applications.filter(isActionable) : [];

  // byJobId map — keep jobs only if they retain at least one applicant.
  const byJobId: Record<string, { job: any; applicants: any[] }> = {};
  if (data.byJobId && typeof data.byJobId === "object") {
    for (const [jobId, group] of Object.entries(data.byJobId as Record<string, any>)) {
      const kept = Array.isArray(group?.applicants) ? group.applicants.filter(isActionable) : [];
      if (kept.length > 0) byJobId[jobId] = { job: group.job, applicants: kept };
    }
  }

  return {
    status: r.status,
    body: {
      ...r.body,
      data: {
        ...data,
        applications: flat,
        byJobId,
        totalApplications: flat.length,
      },
    },
  };
}

function clampLimit(n: any): number {
  const v = typeof n === "number" ? n : parseInt(n);
  if (!Number.isFinite(v) || v <= 0) return 20;
  return Math.min(v, 50);
}

/**
 * Coerce a single date input (any shape the agent might send) into a
 * `YYYY-MM-DD` string. Returns null when nothing parseable is left.
 *
 * Accepted inputs:
 *   - "2026-05-21"                  → unchanged
 *   - "2026-05-21T..."              → date portion only
 *   - "May 21" / "May 21 2026"      → resolved against current year
 *   - "21" / "21 May" / "21/5"      → best-effort
 */
function toIsoDate(raw: any, fallbackYear: number): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") raw = String(raw);
  const s = raw.trim();
  if (!s) return null;
  // Already ISO?
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  // Try Date.parse with the year appended if missing.
  const hasYear = /\b(20|19)\d{2}\b/.test(s);
  const candidate = hasYear ? s : `${s} ${fallbackYear}`;
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return null;
  // If the year is missing AND the parsed date is more than 30d in the past,
  // bump it to next year (intent was almost certainly future).
  if (!hasYear) {
    const now = new Date();
    if (d.getTime() < now.getTime() - 30 * 24 * 3600 * 1000) {
      d.setFullYear(d.getFullYear() + 1);
    }
  }
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Expand a textual date range like "may 21-24" or "May 21 - May 23 2026"
 * into a list of ISO dates. Returns null when no clear start/end can be
 * extracted (caller falls back to single-date parse).
 */
function expandDateRange(raw: string, fallbackYear: number): string[] | null {
  // Pattern A: same month — "may 21-24" / "May 21-24 2026"
  const m1 = raw.match(/^(.+?)\s*(\d{1,2})\s*[-–to]+\s*(\d{1,2})\b(.*)$/i);
  if (m1) {
    const [, prefix, startDay, endDay, suffix] = m1;
    const start = toIsoDate(`${prefix.trim()} ${startDay} ${suffix.trim()}`.trim(), fallbackYear);
    const end = toIsoDate(`${prefix.trim()} ${endDay} ${suffix.trim()}`.trim(), fallbackYear);
    if (start && end) return enumerateDates(start, end);
  }
  // Pattern B: full-date range — "2026-05-21 to 2026-05-23" / "May 21 - May 23 2026"
  const m2 = raw.match(/^(.+?)\s*(?:to|through|-)\s*(.+)$/i);
  if (m2) {
    const start = toIsoDate(m2[1], fallbackYear);
    const end = toIsoDate(m2[2], fallbackYear);
    if (start && end) return enumerateDates(start, end);
  }
  return null;
}

function enumerateDates(startIso: string, endIso: string): string[] {
  const out: string[] = [];
  const start = new Date(startIso + "T00:00:00");
  const end = new Date(endIso + "T00:00:00");
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return [startIso];
  if (end.getTime() < start.getTime()) return [startIso];
  // Cap at a reasonable consulting-gig length so a typo can't generate 1000 entries.
  const MAX = 60;
  let cur = start;
  while (cur.getTime() <= end.getTime() && out.length < MAX) {
    const yyyy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, "0");
    const dd = String(cur.getDate()).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
    cur = new Date(cur.getTime() + 24 * 3600 * 1000);
  }
  return out;
}

/**
 * Mutates `input` in place: turns the agent's `dates` field (array, comma-
 * separated string, or range) into a clean `string[]` of ISO dates, and
 * auto-derives `total_days` from the resulting list when the agent forgot.
 * Used by both preview_post_consulting_job and confirm_post_consulting_job.
 */
function normalizeDatesInPlace(input: any): void {
  if (!input) return;
  const fallbackYear = new Date().getFullYear();
  let dates: string[] = [];

  if (Array.isArray(input.dates)) {
    dates = (input.dates as any[])
      .map((d: any) => toIsoDate(d, fallbackYear))
      .filter((d: string | null): d is string => !!d);
  } else if (typeof input.dates === "string") {
    const raw = input.dates.trim();
    // Range first (handles "may 21-24" before splitting on `-`).
    const expanded = expandDateRange(raw, fallbackYear);
    if (expanded) {
      dates = expanded;
    } else if (raw.includes(",")) {
      // "may 21,22,23" — propagate the prefix (month name) onto bare numbers.
      const parts = raw.split(",").map((p: string) => p.trim()).filter(Boolean);
      let lastPrefix = "";
      const expandedParts: string[] = [];
      for (const p of parts) {
        // If part is bare number, prepend last prefix (e.g. "may ").
        if (/^\d{1,2}$/.test(p) && lastPrefix) {
          expandedParts.push(`${lastPrefix} ${p}`);
        } else {
          expandedParts.push(p);
          // Capture the month-word prefix for later bare-number parts.
          const prefixMatch = p.match(/^([A-Za-z]+)\s+\d/);
          if (prefixMatch) lastPrefix = prefixMatch[1];
        }
      }
      dates = expandedParts
        .map((p) => toIsoDate(p, fallbackYear))
        .filter((d): d is string => !!d);
    } else {
      const single = toIsoDate(raw, fallbackYear);
      if (single) dates = [single];
    }
  }

  // Dedupe + sort for stability (and so total_days reflects unique days).
  dates = Array.from(new Set(dates)).sort();
  input.dates = dates;

  // ALWAYS overwrite total_days from the resolved dates array — the dates
  // list is the source of truth. The agent frequently miscounts inclusive
  // ranges (e.g. "May 21–25" = 5 days, not 4). Letting the agent's stale
  // total_days through here trips the handler's "Dates count must match
  // total_days" validator and cancels the post.
  if (dates.length > 0) {
    input.total_days = dates.length;
  }
}

/**
 * Mutates `input` in place: turns whatever shape the agent put in
 * `professional_role` / `professional_roles` into the canonical snake_case
 * dbValue(s) the backend handlers accept. Drops fields that can't be
 * resolved so the handler returns a clear "missing role" error rather
 * than "Invalid professional role".
 */
function normalizeProfessionalRoleInPlace(input: any): void {
  if (input == null) return;
  if (typeof input.professional_role === "string") {
    const v = normalizeRoleToDbValue(input.professional_role);
    if (v) input.professional_role = v;
    else delete input.professional_role;
  }
  if (Array.isArray(input.professional_roles)) {
    const cleaned = (input.professional_roles as any[])
      .map((r) => (typeof r === "string" ? normalizeRoleToDbValue(r) : undefined))
      .filter((r): r is string => !!r);
    if (cleaned.length > 0) input.professional_roles = cleaned;
    else delete input.professional_roles;
  }
}

/**
 * Normalize whatever the model passed for `professionalRole` into the
 * canonical snake_case dbValue the backend handlers accept. Tolerates:
 *   - dbValue ("dental_hygienist")            → returned as-is
 *   - cognitoGroup ("DentalHygienist")        → mapped via PROFESSIONAL_ROLES
 *   - display name ("Dental Hygienist")       → mapped via PROFESSIONAL_ROLES
 *   - unrecognized                            → returns undefined (caller should drop the param)
 */
function normalizeRoleToDbValue(input: string): string | undefined {
  const lower = input.trim().toLowerCase();
  if (!lower) return undefined;
  // dbValue (any case)?
  const dbHit = (VALID_ROLE_VALUES as readonly string[]).find(v => v.toLowerCase() === lower);
  if (dbHit) return dbHit;
  // Cognito group?
  const fromGroup = PROFESSIONAL_ROLES.find(r => r.cognitoGroup.toLowerCase() === lower);
  if (fromGroup) return fromGroup.dbValue;
  // Display name?
  const fromName = PROFESSIONAL_ROLES.find(r => r.name.toLowerCase() === lower);
  if (fromName) return fromName.dbValue;
  return undefined;
}

/**
 * Normalize whatever shape the model passed for clinic identifiers into a
 * proper `clinicIds: string[]` of UUIDs on the input object. Tolerates:
 *   - `clinicId` singular → wrap to array
 *   - comma-separated string → split
 *   - bracketed string Bedrock-style — `"[uuid]"` or `"[\"uuid\"]"`
 *     (the agent declares array-typed params but Bedrock often emits them
 *     as stringified array literals; without quotes around the UUIDs,
 *     `JSON.parse` upstream fails and we end up with literal brackets in
 *     the value). The fix: strip surrounding `[ ]` and any per-element
 *     quotes before splitting.
 *   - clinic NAMES → resolve via `userContext.clinics` cache
 *   - already-canonical UUID arrays → leave alone
 * Idempotent. Mutates `input.clinicIds`. Deletes `input.clinicId`.
 */
function normalizeClinicIdsInPlace(input: any, userContext: SessionContextSnapshot | undefined): void {
  const ctxClinics = (userContext?.clinics || []) as Array<{ clinicId: string; name?: string }>;
  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const resolveByName = (s: string): string | null => {
    const lower = s.trim().toLowerCase();
    const hit = ctxClinics.find(c => (c.name || "").toLowerCase() === lower);
    return hit?.clinicId || null;
  };

  // Strip per-element wrappers: `[uuid]` → `uuid`, `"uuid"` → `uuid`, `'uuid'` → `uuid`.
  const cleanOne = (s: string): string => s.trim().replace(/^[\[\]"']+|[\[\]"']+$/g, "").trim();

  const raw = input.clinicIds ?? input.clinicId;
  let arr: string[] | undefined;

  if (Array.isArray(raw)) {
    arr = (raw as any[]).map((v) => (typeof v === "string" ? cleanOne(v) : String(v)));
  } else if (typeof raw === "string") {
    // First attempt: strict JSON parse (handles `["uuid"]` form).
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fall through */ }
    if (Array.isArray(parsed)) {
      arr = parsed.map((v) => (typeof v === "string" ? cleanOne(v) : String(v)));
    } else {
      // Strip surrounding brackets, then split by comma. Tolerates Bedrock's
      // `[uuid]` / `[uuid1, uuid2]` shape where the UUIDs are unquoted.
      let trimmed = raw.trim();
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
        trimmed = trimmed.slice(1, -1);
      }
      arr = trimmed.split(",").map(cleanOne).filter(Boolean);
    }
  }

  if (arr && arr.length > 0) {
    arr = arr.map((s: string) => (UUID_RE.test(s) ? s : (resolveByName(s) || s)));
    input.clinicIds = arr;
    delete input.clinicId;
  }
}

// ---------- Generic preview/confirm helpers ----------

/** Standard "render confirm card" preview tool — validates payload, stores it, returns the card. */
async function genericPreview(
  toolName: string,
  auth: AuthContext,
  connectionId: string,
  input: Record<string, any>,
  validate?: (i: Record<string, any>) => string | null,
): Promise<ToolResult> {
  if (validate) {
    const v = validate(input);
    if (v) return err(toolName, 400, v);
  }
  const previewToken = await setPendingPreview(auth.userSub, connectionId, toolName, input);
  return ok(toolName, {
    kind: "confirm_card",
    action: toolName.replace(/^preview_/, ""),
    previewToken,
    fields: input,
    warnings: [],
    confirmTool: toolName.replace(/^preview_/, "confirm_"),
  });
}

/** Standard "verify gate then execute" confirm tool. */
async function genericConfirm(
  toolName: string,
  auth: AuthContext,
  connectionId: string,
  input: Record<string, any>,
  exec: (payloadWithoutToken: Record<string, any>) => Promise<{ status: number; body: any }>,
): Promise<ToolResult> {
  const { previewToken, ...payload } = input;
  const gate = await verifyPreviewBeforeConfirm(auth.userSub, connectionId, toolName, previewToken, payload);
  if (!gate.ok) return err(toolName, gate.status, gate.reason);
  const result = await exec(payload);
  await clearPendingPreview(auth.userSub, connectionId);
  if (result.status >= 400) return err(toolName, result.status, safeBodyToString(result.status, result.body));
  return ok(toolName, result.body);
}

// =========================================================================
// MAIN DISPATCH
// =========================================================================

/** Per-user context (profile, home, clinics) cached on the session row.
 *  Shape matches `UserContext` from userContext.ts but typed loose here so the
 *  executor doesn't need a circular import on session lifecycle. */
export interface SessionContextSnapshot {
  agentType?: "professional" | "clinic" | "public";
  home?: { lat: number; lng: number; city?: string; state?: string };
  clinics?: Array<{ clinicId: string; name?: string; city?: string; state?: string }>;
  [k: string]: any;
}

export async function executeTool(
  call: ToolCall,
  auth: AuthContext,
  connectionId: string,
  userContext?: SessionContextSnapshot,
): Promise<ToolResult> {
  const def = getToolDefinition(call.toolName);
  if (!def) return err(call.toolName, 400, `Unknown tool: ${call.toolName}`);

  // One-line dispatch trace so CloudWatch can answer "did the agent call X or Y?"
  // without needing to enable Bedrock model-invocation logs.
  console.log(`[toolDispatch] tool=${call.toolName} input=${JSON.stringify(call.input || {})}`);

  try {
    switch (call.toolName) {
      // ------------------- PROFESSIONAL: search / info -------------------
      case "search_jobs_near_me": {
        // Use the same handler the website's pro find-jobs page uses:
        // /professionals/filtered-jobs (auth, relevance-scored, excludes
        // already-applied, supports lat/lng radius). This makes the chatbot's
        // results match what the user sees in the UI.
        const requestedLimit = clampLimit(call.input.limit);
        const home = userContext?.home;
        const radiusMiles = typeof call.input.radiusMiles === "number" && call.input.radiusMiles > 0
          ? call.input.radiusMiles
          : 50;
        const qs: Record<string, string> = {
          limit: String(requestedLimit),
          radius: String(radiusMiles),
        };
        if (home?.lat) qs.userLat = String(home.lat);
        if (home?.lng) qs.userLng = String(home.lng);
        if (call.input.professionalRole) {
          // Normalize whatever shape the model passed (Cognito group / display
          // name / dbValue) to the snake_case dbValue the handler expects.
          // Drop the param entirely on unknown values rather than 400-ing.
          const norm = normalizeRoleToDbValue(String(call.input.professionalRole));
          if (norm) qs.role = norm;
        }
        if (call.input.jobType) qs.jobType = String(call.input.jobType);
        if (typeof call.input.minRate === "number") qs.minRate = String(call.input.minRate);
        if (typeof call.input.maxRate === "number") qs.maxRate = String(call.input.maxRate);
        if (call.input.dateFrom) qs.start = String(call.input.dateFrom);
        if (call.input.dateTo) qs.end = String(call.input.dateTo);

        const r = await callHandlerInProcess(getProfessionalFilteredJobsHandler, {
          method: "GET",
          queryStringParameters: qs,
          auth,
        });

        // Defensive fallback: if the canonical handler is unavailable for any
        // reason (e.g. 4xx for missing config), fall back to the basic public
        // browser. Better degraded results than no results.
        let body: any = r.body;
        if (r.status >= 400) {
          console.warn(`[toolExecutor] getProfessionalFilteredJobs failed (${r.status}), falling back to runBrowseJobPostings`);
          const normRole = call.input.professionalRole
            ? normalizeRoleToDbValue(String(call.input.professionalRole))
            : undefined;
          const fallback = await runBrowseJobPostings({
            jobType: call.input.jobType, professionalRole: normRole,
            shiftSpeciality: call.input.shiftSpeciality, minRate: call.input.minRate,
            maxRate: call.input.maxRate, dateFrom: call.input.dateFrom, dateTo: call.input.dateTo,
            assistedHygiene: call.input.assistedHygiene,
            limit: Math.min(requestedLimit * 4, 200),
          }, auth);
          if (fallback.status >= 400) return err(call.toolName, fallback.status, safeBodyToString(fallback.status, fallback.body));
          body = fallback.body;
        }

        // Normalize the response shape so the frontend renderer (JobResultsList)
        // can handle either source.
        const postings: any[] = body?.jobs || body?.jobPostings || [];

        // If the canonical handler didn't apply distance (no home coords),
        // do a best-effort Haversine on what we got.
        let finalPostings = postings;
        if (home?.lat && home?.lng) {
          finalPostings = postings.map((p: any) => {
            if (typeof p?.distanceMiles === "number") return p; // handler already provided
            if (typeof p?.lat === "number" && typeof p?.lng === "number") {
              const miles = haversineDistance(home.lat, home.lng, p.lat, p.lng);
              return { ...p, distanceMiles: Math.round(miles * 10) / 10 };
            }
            return p;
          }).sort((a: any, b: any) => (a.distanceMiles ?? 9999) - (b.distanceMiles ?? 9999));
        }

        // Day-of-week filter applied AFTER the handler returns and BEFORE
        // the limit slice — otherwise we'd cap at requestedLimit, then
        // filter, and end up with far fewer than the user asked for. The
        // handler already honored dateFrom/dateTo via qs.start/end so those
        // are server-side at the underlying handler level.
        const dow = normalizeDayOfWeek(call.input.dayOfWeek);
        if (dow !== undefined) {
          finalPostings = finalPostings.filter((p: any) => {
            const date: string | undefined = p?.date || (Array.isArray(p?.dates) ? p.dates[0] : undefined);
            if (!date || typeof date !== "string") return false;
            const d = new Date(date.length === 10 ? date + "T00:00:00" : date);
            return !Number.isNaN(d.getTime()) && d.getDay() === dow;
          });
        }
        finalPostings = finalPostings.slice(0, requestedLimit);

        await setRecentSearchResults(auth.userSub, connectionId, finalPostings.slice(0, 20));
        return ok(call.toolName, {
          jobPostings: finalPostings,
          totalCount: finalPostings.length,
          radiusMiles,
          filteredByDistance: !!home,
        });
      }
      case "get_job_details": {
        const r = await callHandlerInProcess(getJobPostingHandler, {
          method: "GET", pathParameters: { jobId: call.input.jobId }, auth,
        });
        return errOrOk(call.toolName, r);
      }
      case "get_my_applications": {
        const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
        const filtered = filterShiftsByDayAndDateRange(r, {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: call.input.dateFrom,
          dateTo: call.input.dateTo,
        });
        return errOrOk(call.toolName, filtered);
      }
      case "get_my_invitations": {
        const r = await runGetJobInvitations(auth);
        const filtered = filterShiftsByDayAndDateRange(r, {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: call.input.dateFrom,
          dateTo: call.input.dateTo,
        });
        return errOrOk(call.toolName, filtered);
      }
      case "get_my_negotiations": {
        const r = await callHandlerInProcess(getAllNegotiationsProfHandler, { method: "GET", auth });
        return errOrOk(call.toolName, r);
      }
      case "get_scheduled_shifts": {
        // Pros: getJobApplications IGNORES ?status=, so we filter applications
        // in-place to match the dashboard's "Scheduled" tab — anything where
        // applicationStatus is scheduled / accepted / hired / confirmed.
        // Clinics: dedicated clinic-side handler returns already-filtered.
        const dateOpts = {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: call.input.dateFrom,
          dateTo: call.input.dateTo,
        };
        const isPro = (auth.userType || "").toLowerCase().startsWith("prof");
        if (isPro || !call.input.clinicId) {
          const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
          const byStatus = filterApplicationsByStatusInResult(r, ["scheduled", "accepted", "hired", "confirmed"]);
          return errOrOk(call.toolName, filterShiftsByDayAndDateRange(byStatus, dateOpts));
        }
        const r = await callHandlerInProcess(getScheduledShiftsHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId },
          auth,
        });
        return errOrOk(call.toolName, filterShiftsByDayAndDateRange(r, dateOpts));
      }
      case "get_completed_shifts": {
        const dateOpts = {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: call.input.dateFrom,
          dateTo: call.input.dateTo,
        };
        const isPro = (auth.userType || "").toLowerCase().startsWith("prof");
        if (isPro || !call.input.clinicId) {
          const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
          const byStatus = filterApplicationsByStatusInResult(r, ["completed"]);
          return errOrOk(call.toolName, filterShiftsByDayAndDateRange(byStatus, dateOpts));
        }
        const r = await callHandlerInProcess(getCompletedShiftsHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId },
          auth,
        });
        return errOrOk(call.toolName, filterShiftsByDayAndDateRange(r, dateOpts));
      }

      // ------------------- PROFESSIONAL: single-shot writes (v1) -------------------
      case "apply_to_job": {
        if (!call.input.jobId || typeof call.input.jobId !== "string") {
          return err(call.toolName, 400, "jobId is required");
        }
        const body: Record<string, any> = { jobId: call.input.jobId };
        if (call.input.message) body.message = call.input.message;
        if (call.input.startDate) body.startDate = call.input.startDate;
        if (call.input.notes) body.notes = call.input.notes;
        // NEVER pass proposedRate / proposedSalaryMin / proposedSalaryMax here —
        // those flip the backend into a "negotiating" application + create an
        // inline JobNegotiations row. Pure apply must stay status="pending".
        const r = await callHandlerInProcess(createJobApplicationHandler, {
          method: "POST",
          pathParameters: { jobId: call.input.jobId }, // backend reads from path OR body
          body,
          auth,
        });
        return errOrOk(call.toolName, r);
      }

      case "respond_invitation": {
        if (!call.input.invitationId) return err(call.toolName, 400, "invitationId is required");
        if (!["accepted", "declined"].includes(call.input.response)) {
          return err(call.toolName, 400, "response must be 'accepted' or 'declined' (use preview_negotiate for counter-offers)");
        }
        const r = await callHandlerInProcess(respondToInvitationHandler, {
          method: "POST",
          pathParameters: { invitationId: call.input.invitationId },
          body: { response: call.input.response, message: call.input.message },
          auth,
        });
        return errOrOk(call.toolName, r);
      }

      // ------------------- PROFESSIONAL: legacy preview/confirm pairs (kept for back-compat) -------------------
      // Stale alias versions of the agent may still emit `preview_apply_to_job`.
      // The legacy schema demanded proposedRate / availability / message, which
      // caused the agent to interrogate the user before applying. Drop those
      // requirements — only jobId is needed. The 2-step preview/confirm flow
      // is preserved so the UI's confirm card still renders.
      case "preview_apply_to_job":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.jobId || typeof i.jobId !== "string") return "jobId is required";
          return null;
        });
      case "confirm_apply_to_job":
        // If a stale agent reaches the confirm step before the redeploy
        // catches up, route it through the same single-shot path. Ignore
        // proposedRate / availability — pure apply must stay pending.
        return genericConfirm(call.toolName, auth, connectionId, call.input, async (p) => {
          const r = await callHandlerInProcess(createJobApplicationHandler, {
            method: "POST",
            pathParameters: { jobId: p.jobId },
            body: { jobId: p.jobId, message: p.message, startDate: p.startDate, notes: p.notes },
            auth,
          });
          return { status: r.status, body: r.body };
        });

      case "preview_respond_invitation":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.invitationId) return "invitationId is required";
          if (!["accepted", "declined", "negotiating"].includes(i.response)) return "Invalid response";
          return null;
        });
      case "confirm_respond_invitation":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(respondToInvitationHandler, {
            method: "POST",
            pathParameters: { invitationId: p.invitationId },
            body: p,
            auth,
          }),
        );

      case "preview_withdraw_application":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.applicationId ? null : "applicationId is required",
        );
      case "confirm_withdraw_application":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(deleteJobApplicationHandler, {
            method: "DELETE",
            pathParameters: { applicationId: p.applicationId },
            auth,
          }),
        );

      // ------------------- CLINIC: info -------------------
      case "get_my_clinics": {
        const r = await callHandlerInProcess(getUsersClinicsHandler, { method: "GET", auth });
        return errOrOk(call.toolName, r);
      }
      case "get_action_needed": {
        const r = await callHandlerInProcess(getActionNeededHandler, {
          method: "GET", pathParameters: { clinicId: call.input.clinicId }, auth,
        });
        return errOrOk(call.toolName, r);
      }
      case "get_open_shifts": {
        const r = await callHandlerInProcess(getClinicShiftsHandler, {
          method: "GET", pathParameters: { clinicId: call.input.clinicId }, auth,
        });
        // Server-side filter for dayOfWeek + date range. Doing this here
        // (not in the LLM) means "open shifts for Monday" can't be wrong
        // because Haiku miscomputed a calendar day. The agent just passes
        // the param; we own the calendar math.
        const filtered = filterShiftsByDayAndDateRange(r, {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: call.input.dateFrom,
          dateTo: call.input.dateTo,
        });
        return errOrOk(call.toolName, filtered);
      }
      case "list_applicants_for_job": {
        // Three modes:
        //   1. jobId given      → single-job view
        //   2. clinicId given   → all of one clinic's actionable applicants
        //   3. neither given    → fan out across EVERY clinic the user manages
        //                        and merge — mirrors the dashboard's
        //                        /dashboard/all/action-needed aggregate path.
        const qs: Record<string, string> = { limit: "200" };
        if (call.input.jobId) qs.jobId = call.input.jobId;

        const callOne = async (cid: string) => {
          const single = await callHandlerInProcess(getJobApplicantsOfAClinicHandler, {
            method: "GET",
            pathParameters: { clinicId: cid },
            queryStringParameters: qs,
            auth,
          });
          // Annotate the job rows with the clinic name from session context so
          // the merged response can label each card with its owning clinic.
          if (single.status < 400 && single.body?.data) {
            const cmeta = (userContext?.clinics || []).find((c: any) => c.clinicId === cid);
            const cname = cmeta?.name;
            const data = single.body.data;
            if (cname && data.byJobId && typeof data.byJobId === "object") {
              for (const g of Object.values<any>(data.byJobId)) {
                if (g?.job && !g.job.clinicName) g.job.clinicName = cname;
                if (g?.job && !g.job.clinic) g.job.clinic = cname;
              }
            }
          }
          return single;
        };

        let r: { status: number; body: any };
        const clinicIdGiven = call.input.clinicId && typeof call.input.clinicId === "string";
        let userClinics: string[] = (userContext?.clinics || [])
          .map((c: any) => c.clinicId)
          .filter((id: any) => typeof id === "string" && id.length > 0);

        // Session context only fetches from UserClinicAssignments — a user
        // who CREATED a clinic but never wrote an assignment row will show up
        // with zero clinics here even though they own one. Live-fetch via the
        // same handler get_my_clinics uses (scans Clinics for createdBy +
        // AssociatedUsers membership) so the fan-out has something to chew on.
        if (userClinics.length === 0 && !clinicIdGiven && !call.input.jobId) {
          try {
            const cr = await callHandlerInProcess(getUsersClinicsHandler, { method: "GET", auth });
            if (cr.status < 400 && Array.isArray(cr.body?.clinics)) {
              userClinics = cr.body.clinics
                .map((c: any) => c?.clinicId)
                .filter((id: any) => typeof id === "string" && id.length > 0);
              console.log(`[list_applicants_for_job] live-fetched ${userClinics.length} clinics (session had 0)`);
            }
          } catch (e: any) {
            console.warn("[list_applicants_for_job] live clinic fetch failed:", e?.message || e);
          }
        }

        if (!clinicIdGiven && userClinics.length === 0) {
          return err(call.toolName, 400, "No clinics found for this user. Ask them to set one up first.");
        }

        if (clinicIdGiven) {
          r = await callOne(call.input.clinicId);
        } else if (userClinics.length === 1) {
          r = await callOne(userClinics[0]);
        } else {
          // Multi-clinic fan-out. Run in parallel; surface 200 even if some
          // clinics fail — chat is best-effort visible, not all-or-nothing.
          console.log(`[list_applicants_for_job] aggregating across ${userClinics.length} clinics`);
          const results = await Promise.all(
            userClinics.map((cid) =>
              callOne(cid).catch((e) => {
                console.warn(`[list_applicants_for_job] clinic=${cid} failed:`, e?.message || e);
                return { status: 500, body: null } as { status: number; body: any };
              }),
            ),
          );
          const mergedByJobId: Record<string, any> = {};
          const mergedApps: any[] = [];
          let total = 0;
          for (const single of results) {
            if (single.status >= 400 || !single.body?.data) continue;
            const data = single.body.data;
            if (Array.isArray(data.applications)) mergedApps.push(...data.applications);
            if (data.byJobId && typeof data.byJobId === "object") {
              for (const [jid, group] of Object.entries(data.byJobId as Record<string, any>)) {
                mergedByJobId[jid] = group;
              }
            }
            total += data.totalApplications || 0;
          }
          r = {
            status: 200,
            body: {
              status: "success",
              statusCode: 200,
              data: {
                aggregated: true,
                clinicCount: userClinics.length,
                totalApplications: total,
                applications: mergedApps,
                byJobId: mergedByJobId,
              },
            },
          };
        }

        // Strict whitelist: pending + negotiating only — same as the dashboard
        // Action Needed view. Drops empty jobs from byJobId after filtering.
        return errOrOk(call.toolName, filterApplicantsToActionableInResult(r));
      }
      case "get_professional_info": {
        const r = await callHandlerInProcess(getPublicProfessionalProfileHandler, {
          method: "GET", pathParameters: { userSub: call.input.userSub }, auth,
        });
        return errOrOk(call.toolName, r);
      }
      case "get_clinic_favorites": {
        const r = await callHandlerInProcess(getClinicFavoritesHandler, { method: "GET", auth });
        return errOrOk(call.toolName, r);
      }

      // ------------------- CLINIC: response (preview/confirm) -------------------
      case "preview_post_temporary_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!Array.isArray(i.clinicIds) || i.clinicIds.length === 0) return "clinicIds required (array of clinic UUIDs)";
          if (!i.professional_role) return "professional_role required";
          if (!i.date) return "date required";
          if (!i.shift_speciality) return "shift_speciality required";
          if (typeof i.hours !== "number" || i.hours < 1 || i.hours > 12) return "hours must be 1-12";
          if (typeof i.rate !== "number") return "rate required";
          if (!i.start_time || !i.end_time) return "start_time and end_time required";
          return null;
        });
      case "confirm_post_temporary_job":
        // Defensive: re-normalize on confirm even though preview also
        // normalizes. The widget echoes whatever was in the preview-card
        // payload, so if a prior preview stored a Bedrock-malformed value
        // (bracketed clinicId string, display-name role) we'd still see
        // it here. Normalizing twice is harmless.
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) => {
          normalizeClinicIdsInPlace(p, userContext);
          normalizeProfessionalRoleInPlace(p);
          return callHandlerInProcess(createTemporaryJobHandler, { method: "POST", body: p, auth });
        });

      case "preview_post_consulting_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        normalizeDatesInPlace(call.input);
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!Array.isArray(i.clinicIds) || i.clinicIds.length === 0) return "clinicIds required (array of UUIDs)";
          if (!Array.isArray(i.dates) || i.dates.length === 0) {
            return `dates required (got: ${JSON.stringify(call.input.dates)}). Pass an array of ISO dates like ["2026-05-21","2026-05-22"] OR a string like "may 21-24".`;
          }
          if (typeof i.total_days !== "number") return "total_days required";
          if (typeof i.hours_per_day !== "number") return "hours_per_day required";
          return null;
        });
      case "confirm_post_consulting_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        normalizeDatesInPlace(call.input);
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) => {
          normalizeClinicIdsInPlace(p, userContext);
          normalizeProfessionalRoleInPlace(p);
          normalizeDatesInPlace(p);
          return callHandlerInProcess(createMultiDayConsultingHandler, { method: "POST", body: p, auth });
        });

      case "preview_post_permanent_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!Array.isArray(i.clinicIds) || i.clinicIds.length === 0) return "clinicIds required (array of UUIDs)";
          if (!i.employment_type) return "employment_type required";
          if (!Array.isArray(i.benefits)) return "benefits must be an array";
          if (typeof i.salary_min === "number" && typeof i.salary_max === "number" && i.salary_max <= i.salary_min) {
            return "salary_max must be greater than salary_min";
          }
          return null;
        });
      case "confirm_post_permanent_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        normalizeProfessionalRoleInPlace(call.input);
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) => {
          normalizeClinicIdsInPlace(p, userContext);
          normalizeProfessionalRoleInPlace(p);
          return callHandlerInProcess(createPermanentJobHandler, { method: "POST", body: p, auth });
        });

      case "preview_accept_professional":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.jobId && i.professionalUserSub ? null : "jobId and professionalUserSub required",
        );
      case "confirm_accept_professional":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(acceptProfHandler, {
            method: "POST",
            pathParameters: { jobId: p.jobId },
            body: { professionalUserSub: p.professionalUserSub, acceptedRate: p.acceptedRate, message: p.message },
            auth,
          }),
        );

      case "preview_reject_professional":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.clinicId && i.jobId && i.professionalUserSub ? null : "clinicId, jobId, professionalUserSub required",
        );
      case "confirm_reject_professional":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(rejectProfHandler, {
            method: "POST",
            pathParameters: { clinicId: p.clinicId, jobId: p.jobId },
            body: { professionalUserSub: p.professionalUserSub, reason: p.reason },
            auth,
          }),
        );

      case "preview_send_invitations":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.jobId) return "jobId required";
          if (!Array.isArray(i.professionalUserSubs) || i.professionalUserSubs.length === 0) return "professionalUserSubs required";
          return null;
        });
      case "confirm_send_invitations":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(sendJobInvitationsHandler, {
            method: "POST",
            pathParameters: { jobId: p.jobId },
            body: { professionalUserSubs: p.professionalUserSubs, invitationMessage: p.invitationMessage, urgency: p.urgency },
            auth,
          }),
        );

      // =================================================================
      // PHASE 4 — Pro tools
      // =================================================================

      case "preview_negotiate":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.applicationId || !i.negotiationId) return "applicationId and negotiationId required";
          if (!["accepted", "declined", "counter_offer"].includes(i.response)) return "Invalid response";
          return null;
        });
      case "confirm_negotiate":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(respondToNegotiationHandler, {
            method: "PUT",
            pathParameters: { applicationId: p.applicationId, negotiationId: p.negotiationId },
            body: {
              response: p.response, message: p.message,
              clinicCounterRate: p.clinicCounterRate, professionalCounterRate: p.professionalCounterRate,
              counterSalaryMin: p.counterSalaryMin, counterSalaryMax: p.counterSalaryMax,
              payType: p.payType,
            },
            auth,
          }),
        );

      case "preview_attest_completed_shift":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.jobId) return "jobId required";
          if (typeof i.attestedHours !== "number" || i.attestedHours <= 0) return "attestedHours required";
          if (!i.signedAt) return "signedAt required";
          return null;
        });
      case "confirm_attest_completed_shift":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateCompletedShiftsHandler, { method: "PUT", body: p, auth }),
        );

      case "preview_update_my_profile":
        return genericPreview(call.toolName, auth, connectionId, call.input);
      case "confirm_update_my_profile":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateProfessionalProfileHandler, { method: "PUT", body: p, auth }),
        );

      case "preview_update_home_address":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.addressLine1 && i.city && i.state && i.pincode ? null : "addressLine1, city, state, pincode required",
        );
      case "confirm_update_home_address":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateUserAddressHandler, { method: "PUT", body: p, auth }),
        );

      case "preview_update_notification_preferences":
        return genericPreview(call.toolName, auth, connectionId, call.input);
      case "confirm_update_notification_preferences":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateNotificationPreferencesHandler, { method: "PUT", body: p, auth }),
        );

      case "preview_submit_feedback":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.feedback && i.type ? null : "feedback and type required",
        );
      case "confirm_submit_feedback":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(submitFeedbackHandler, { method: "POST", body: p, auth }),
        );

      case "preview_send_referral":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.referredEmail && i.referredName ? null : "referredEmail and referredName required",
        );
      case "confirm_send_referral":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(sendReferralInviteHandler, { method: "POST", body: p, auth }),
        );

      // =================================================================
      // PHASE 4 — Clinic tools
      // =================================================================

      case "preview_mark_shift_completed":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.jobId && i.professionalUserSub && typeof i.attestedHours === "number"
            ? null : "jobId, professionalUserSub, attestedHours required",
        );
      case "confirm_mark_shift_completed":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(confirmShiftCompletionHandler, {
            method: "POST",
            pathParameters: { jobId: p.jobId },
            body: {
              professionalUserSub: p.professionalUserSub,
              attestedHours: p.attestedHours,
              attestedRate: p.attestedRate,
              clinicNotes: p.clinicNotes,
            },
            auth,
          }),
        );

      case "preview_report_no_show":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.jobId && i.professionalUserSub && i.reason ? null : "jobId, professionalUserSub, reason required",
        );
      case "confirm_report_no_show":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(reportNoShowHandler, {
            method: "POST",
            pathParameters: { jobId: p.jobId },
            body: { professionalUserSub: p.professionalUserSub, reason: p.reason, details: p.details },
            auth,
          }),
        );

      case "preview_update_clinic_profile":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.clinicId ? null : "clinicId required",
        );
      case "confirm_update_clinic_profile":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) => {
          const { clinicId, ...rest } = p;
          return callHandlerInProcess(updateClinicProfileHandler, {
            method: "PUT",
            pathParameters: { clinicId },
            body: rest,
            auth,
          });
        });

      case "preview_edit_job":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.jobId ? null : "jobId required",
        );
      case "confirm_edit_job":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) => {
          const { jobId, ...rest } = p;
          return callHandlerInProcess(updateJobPostingHandler, {
            method: "PUT",
            pathParameters: { jobId },
            body: rest,
            auth,
          });
        });

      case "preview_cancel_job":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.jobId ? null : "jobId required",
        );
      case "confirm_cancel_job":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateJobStatusHandler, {
            method: "PUT",
            pathParameters: { jobId: p.jobId },
            body: { status: "inactive", reason: p.reason },
            auth,
          }),
        );

      case "preview_add_clinic_favorite":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.professionalUserSub ? null : "professionalUserSub required",
        );
      case "confirm_add_clinic_favorite":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(addClinicFavoriteHandler, {
            method: "POST",
            body: { professionalUserSub: p.professionalUserSub },
            auth,
          }),
        );

      case "preview_remove_clinic_favorite":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.professionalUserSub ? null : "professionalUserSub required",
        );
      case "confirm_remove_clinic_favorite":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(removeClinicFavoriteHandler, {
            method: "DELETE",
            pathParameters: { professionalUserSub: p.professionalUserSub },
            auth,
          }),
        );

      case "search_professionals": {
        const r = await callHandlerInProcess(getAllProfessionalsHandler, {
          method: "GET",
          queryStringParameters: {
            ...(call.input.role && { role: call.input.role }),
            ...(call.input.speciality && { speciality: call.input.speciality }),
            ...(call.input.limit && { limit: String(call.input.limit) }),
          },
          auth,
        });
        return errOrOk(call.toolName, r);
      }

      case "preview_invite_team_member":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.clinicId || !i.email || !i.role) return "clinicId, email, role required";
          if (!["ClinicManager", "ClinicViewer"].includes(i.role)) return "role must be ClinicManager or ClinicViewer";
          return null;
        });
      case "confirm_invite_team_member":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(createAssignmentHandler, { method: "POST", body: p, auth }),
        );

      case "preview_update_team_member":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.userSub && i.clinicId && i.role ? null : "userSub, clinicId, role required",
        );
      case "confirm_update_team_member":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(updateAssignmentHandler, { method: "PUT", body: p, auth }),
        );

      case "preview_remove_team_member":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) =>
          i.userSub && i.clinicId ? null : "userSub and clinicId required",
        );
      case "confirm_remove_team_member":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(deleteAssignmentHandler, {
            method: "DELETE",
            queryStringParameters: { userSub: p.userSub, clinicId: p.clinicId },
            auth,
          }),
        );

      default:
        return err(call.toolName, 501, `Tool '${call.toolName}' not wired up`);
    }
  } catch (e: any) {
    console.error(`executeTool('${call.toolName}') threw:`, e);
    return err(call.toolName, 500, e?.message || "Tool execution failed");
  }
}

