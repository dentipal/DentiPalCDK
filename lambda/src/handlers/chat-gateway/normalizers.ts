/**
 * Shared input/output normalization helpers for chat tool execution.
 *
 * Lifted verbatim from toolExecutor.ts so both callers stay in lockstep:
 *
 *   1. `chat/toolExecutor.ts`         — today's Bedrock Agents path, still
 *                                       calls these in-process per tool case.
 *   2. `chat-gateway/wrappers/<tool>.ts` — WS-3 MCP wrapper Lambdas. Each
 *                                       Gateway tool target that needs
 *                                       normalization invokes a thin Lambda
 *                                       that calls one of these helpers
 *                                       before delegating to the underlying
 *                                       business handler.
 *
 * Keeping the source of truth here (and re-exporting from toolExecutor for
 * back-compat) means the LangGraph.js agents (WS-4) get the same fix every
 * time we improve a normalizer — no parallel implementations to drift.
 *
 * None of these helpers throws; they MUTATE the input in place (the
 * `*InPlace` variants) or return a new shape (the filter helpers). All are
 * idempotent so running them twice is safe.
 */

import { PROFESSIONAL_ROLES, VALID_ROLE_VALUES } from "../professionalRoles";

// ─────────────────────────────────────────────────────────────────────────
// Date / shift filtering
// ─────────────────────────────────────────────────────────────────────────

/**
 * Map a user-supplied weekday string to a JS Date.getDay() index (0=Sun..6=Sat).
 * Accepts case-insensitive 3-letter abbreviations or full names. Returns
 * undefined for any value we don't recognize so the caller skips the filter
 * rather than producing wrong results.
 */
export function normalizeDayOfWeek(v: any): number | undefined {
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
 * Collect EVERY shift date a row carries. A row may have one, the other, or
 * both of these shapes:
 *   - single-day:  `date` (legacy) and/or `start_date` (snake_case, current).
 *                  Older `startDate` (camelCase) also probed.
 *   - multi-day:   `dates: ["YYYY-MM-DD", ...]` — all returned so day-of-week
 *                  filtering can match if ANY date lands on the requested weekday.
 * Applications/invitations carry these inside `jobPosting`/`job` sub-objects,
 * so we probe both the direct row and one level down.
 *
 * Returns an empty array when nothing parseable is found — caller treats that
 * as "exclude this row" (we can't filter what we can't date).
 */
export function extractShiftDates(row: any): string[] {
  if (!row || typeof row !== "object") return [];
  const probe = (obj: any): string[] => {
    if (!obj || typeof obj !== "object") return [];
    const out: string[] = [];
    if (Array.isArray(obj.dates)) {
      for (const d of obj.dates) {
        if (typeof d === "string" && d.length >= 8) out.push(d);
      }
    }
    for (const k of ["date", "start_date", "startDate"]) {
      const v = obj[k];
      if (typeof v === "string" && v.length >= 8) out.push(v);
    }
    return out;
  };
  const all = [...probe(row), ...probe(row.jobPosting), ...probe(row.job)];
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const d of all) {
    if (!seen.has(d)) { seen.add(d); deduped.push(d); }
  }
  return deduped;
}

/**
 * Scrub past dates off shift/job postings before they reach the chat widget.
 *
 * The underlying handlers keep multi-day consulting postings whenever at least
 * one date in `dates` is still upcoming, but the card renderer surfaces
 * `dates[0]` — the earliest, which can already be in the past. This helper
 * drops dated single-day postings whose only date is past and drops entire
 * multi-day postings if every occurrence has passed. Permanent postings are
 * left alone (open-ended hires, not date-bound shifts).
 */
export function trimPastDatesFromPostings<T extends Record<string, any>>(postings: T[]): T[] {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const isPastIso = (d: any): boolean => {
    if (typeof d !== "string" || !d) return false;
    const dt = new Date(d.length === 10 ? d + "T00:00:00" : d);
    return !Number.isNaN(dt.getTime()) && dt < today;
  };
  const out: T[] = [];
  for (const p of postings) {
    const datesArr: any[] = Array.isArray((p as any).dates) ? (p as any).dates : [];
    if (datesArr.length > 0) {
      const hasUpcoming = datesArr.some((d) => !isPastIso(d));
      if (!hasUpcoming) continue;
      out.push(p);
      continue;
    }
    const jt = String((p as any).jobType || (p as any).job_type || "").toLowerCase();
    if (jt === "permanent") { out.push(p); continue; }
    const singleDate = (p as any).date || (p as any).startDate || (p as any).start_date;
    if (typeof singleDate === "string" && isPastIso(singleDate)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Server-side filter for shift-list tools. Removes the LLM from the
 * day-of-week / date-range reasoning loop:
 *   - dayOfWeek: "mon" | "monday" | "MON" | ... → restrict to that weekday
 *   - dateFrom / dateTo: inclusive YYYY-MM-DD bounds
 *
 * Probes a known set of envelope shapes (the response shape varies by
 * handler) and rewrites the matched array with an updated count. No-op on
 * error responses or when no filters are supplied.
 */
export function filterShiftsByDayAndDateRange(
  r: { status: number; body: any },
  opts: { dayOfWeek?: any; dateFrom?: any; dateTo?: any },
): { status: number; body: any } {
  if (r.status >= 400 || !r.body || typeof r.body !== "object") return r;
  const dow = normalizeDayOfWeek(opts.dayOfWeek);
  const from = typeof opts.dateFrom === "string" ? opts.dateFrom : undefined;
  const to = typeof opts.dateTo === "string" ? opts.dateTo : undefined;
  if (dow === undefined && !from && !to) return r;

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
  let foundIn: ["data" | "top", string] | "dataArray" | undefined;
  if (Array.isArray(r.body?.data)) {
    arr = r.body.data;
    foundIn = "dataArray";
  } else {
    for (const [loc, key] of candidates) {
      const at = loc === "data" ? r.body?.data?.[key] : r.body?.[key];
      if (Array.isArray(at)) { arr = at; foundIn = [loc, key]; break; }
    }
  }
  if (!arr || !foundIn) return r;

  const kept = arr.filter((s) => {
    const dates = extractShiftDates(s);
    if (!dates.length) return false;
    const inRange = dates.filter((d) => (!from || d >= from) && (!to || d <= to));
    if (!inRange.length) return false;
    if (dow !== undefined) {
      const hit = inRange.some((d) => {
        const dt = new Date(d.length === 10 ? d + "T00:00:00" : d);
        return !Number.isNaN(dt.getTime()) && dt.getDay() === dow;
      });
      if (!hit) return false;
    }
    return true;
  });

  const nextBody = { ...r.body };
  if (foundIn === "dataArray") {
    nextBody.data = kept;
    if (typeof r.body.totalCount === "number") nextBody.totalCount = kept.length;
  } else if (foundIn[0] === "data") {
    nextBody.data = { ...r.body.data, [foundIn[1]]: kept };
    if (typeof r.body.data?.totalCount === "number") nextBody.data.totalCount = kept.length;
  } else {
    nextBody[foundIn[1]] = kept;
    if (typeof r.body.totalCount === "number") nextBody.totalCount = kept.length;
  }
  return { status: r.status, body: nextBody };
}

// ─────────────────────────────────────────────────────────────────────────
// Application / applicant filtering
// ─────────────────────────────────────────────────────────────────────────

/**
 * Filter the `applications` array inside a getJobApplications response down
 * to a status whitelist. The handler ignores `?status=` so we filter on the
 * way out here — keeps the chat's Scheduled / Completed views aligned with
 * the dashboard's tab filters.
 */
export function filterApplicationsByStatusInResult(
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
 * Mirror the dashboard's "Action Needed" filter on the chat side.
 *
 * getJobApplicantsOfAClinic uses a permissive blacklist; the dashboard's
 * Action Needed view uses a STRICT whitelist (pending + negotiate(ing)).
 * Match the strict view so chat surfaces exactly the same set of actionable
 * applicants the dashboard does.
 *
 * Walks both the flat `applications` array and the `byJobId` map; drops
 * jobs whose applicant list becomes empty after filtering and updates
 * `totalApplications` / per-job applicant counts accordingly.
 */
const ACTIONABLE_STATUSES = new Set(["pending", "negotiating", "negotiate"]);
export function filterApplicantsToActionableInResult(
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

  const flat: any[] = Array.isArray(data.applications) ? data.applications.filter(isActionable) : [];

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

// ─────────────────────────────────────────────────────────────────────────
// Date parsing / expansion (for post_consulting_job's `dates` field)
// ─────────────────────────────────────────────────────────────────────────

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
export function toIsoDate(raw: any, fallbackYear: number): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") raw = String(raw);
  const s = raw.trim();
  if (!s) return null;
  const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (isoMatch) return isoMatch[1];
  const hasYear = /\b(20|19)\d{2}\b/.test(s);
  const candidate = hasYear ? s : `${s} ${fallbackYear}`;
  const d = new Date(candidate);
  if (Number.isNaN(d.getTime())) return null;
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
export function expandDateRange(raw: string, fallbackYear: number): string[] | null {
  const m1 = raw.match(/^(.+?)\s*(\d{1,2})\s*[-–to]+\s*(\d{1,2})\b(.*)$/i);
  if (m1) {
    const [, prefix, startDay, endDay, suffix] = m1;
    const start = toIsoDate(`${prefix.trim()} ${startDay} ${suffix.trim()}`.trim(), fallbackYear);
    const end = toIsoDate(`${prefix.trim()} ${endDay} ${suffix.trim()}`.trim(), fallbackYear);
    if (start && end) return enumerateDates(start, end);
  }
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
 */
export function normalizeDatesInPlace(input: any): void {
  if (!input) return;
  const fallbackYear = new Date().getFullYear();
  let dates: string[] = [];

  if (Array.isArray(input.dates)) {
    dates = (input.dates as any[])
      .map((d: any) => toIsoDate(d, fallbackYear))
      .filter((d: string | null): d is string => !!d);
  } else if (typeof input.dates === "string") {
    const raw = input.dates.trim();
    const expanded = expandDateRange(raw, fallbackYear);
    if (expanded) {
      dates = expanded;
    } else if (raw.includes(",")) {
      const parts = raw.split(",").map((p: string) => p.trim()).filter(Boolean);
      let lastPrefix = "";
      const expandedParts: string[] = [];
      for (const p of parts) {
        if (/^\d{1,2}$/.test(p) && lastPrefix) {
          expandedParts.push(`${lastPrefix} ${p}`);
        } else {
          expandedParts.push(p);
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

  dates = Array.from(new Set(dates)).sort();
  input.dates = dates;

  // ALWAYS overwrite total_days from the resolved dates array — the dates
  // list is the source of truth (agent frequently miscounts inclusive ranges).
  if (dates.length > 0) {
    input.total_days = dates.length;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Professional role / clinic id normalization
// ─────────────────────────────────────────────────────────────────────────

/**
 * Normalize whatever the model passed for `professionalRole` into the
 * canonical snake_case dbValue the backend handlers accept. Tolerates:
 *   - dbValue ("dental_hygienist")            → returned as-is
 *   - cognitoGroup ("DentalHygienist")        → mapped via PROFESSIONAL_ROLES
 *   - display name ("Dental Hygienist")       → mapped via PROFESSIONAL_ROLES
 *   - unrecognized                            → returns undefined
 */
export function normalizeRoleToDbValue(input: string): string | undefined {
  const lower = input.trim().toLowerCase();
  if (!lower) return undefined;
  const dbHit = (VALID_ROLE_VALUES as readonly string[]).find(v => v.toLowerCase() === lower);
  if (dbHit) return dbHit;
  const fromGroup = PROFESSIONAL_ROLES.find(r => r.cognitoGroup.toLowerCase() === lower);
  if (fromGroup) return fromGroup.dbValue;
  const fromName = PROFESSIONAL_ROLES.find(r => r.name.toLowerCase() === lower);
  if (fromName) return fromName.dbValue;
  return undefined;
}

/**
 * Mutates `input` in place: turns whatever shape the agent put in
 * `professional_role` / `professional_roles` into the canonical snake_case
 * dbValue(s) the backend handlers accept.
 */
export function normalizeProfessionalRoleInPlace(input: any): void {
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

/** Light shape — just the bits the clinic normalizer needs to resolve
 *  clinic NAMES back to UUIDs. The MCP wrapper Lambdas pass this in from
 *  the per-invocation auth context (the runtime agent hydrates clinics on
 *  session start and forwards them to each tool call). */
export interface ClinicResolverContext {
  clinics?: Array<{ clinicId: string; name?: string }>;
}

/**
 * Normalize whatever shape the model passed for clinic identifiers into a
 * proper `clinicIds: string[]` of UUIDs on the input object. Tolerates:
 *   - `clinicId` singular → wrap to array
 *   - comma-separated string → split
 *   - Bedrock-style bracketed string (`"[uuid]"` / `"[\"uuid\"]"`)
 *   - clinic NAMES → resolve via `userContext.clinics` cache
 *   - already-canonical UUID arrays → leave alone
 * Idempotent. Mutates `input.clinicIds`. Deletes `input.clinicId`.
 */
export function normalizeClinicIdsInPlace(input: any, userContext: ClinicResolverContext | undefined): void {
  const ctxClinics = (userContext?.clinics || []) as Array<{ clinicId: string; name?: string }>;
  const UUID_RE = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
  const resolveByName = (s: string): string | null => {
    const lower = s.trim().toLowerCase();
    const hit = ctxClinics.find(c => (c.name || "").toLowerCase() === lower);
    return hit?.clinicId || null;
  };

  const cleanOne = (s: string): string => s.trim().replace(/^[\[\]"']+|[\[\]"']+$/g, "").trim();

  const raw = input.clinicIds ?? input.clinicId;
  let arr: string[] | undefined;

  if (Array.isArray(raw)) {
    arr = (raw as any[]).map((v) => (typeof v === "string" ? cleanOne(v) : String(v)));
  } else if (typeof raw === "string") {
    let parsed: any = null;
    try { parsed = JSON.parse(raw); } catch { /* fall through */ }
    if (Array.isArray(parsed)) {
      arr = parsed.map((v) => (typeof v === "string" ? cleanOne(v) : String(v)));
    } else {
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

/**
 * Map LLM-friendly pay_type aliases ("hourly", "salary", "tx", "commission")
 * to the handler-required canonical values. The schema's enum is a SOFT
 * constraint -- the Bedrock Agents LLM sometimes still picks the common-
 * English form ("hourly") because that's what the user typed. This server-
 * side mapping is the hard floor: handlers always see a canonical value
 * regardless of what the LLM sent.
 *
 * Idempotent: a value already in canonical form passes through unchanged.
 * Unknown values are LEFT AS-IS so the handler's validation still fires
 * with a clear "invalid pay type" message instead of being silently rewritten.
 *
 * Runs in-place on both preview_ and confirm_ inputs so the gate diff guard
 * compares identical canonical values on both sides (otherwise preview
 * stores "hourly", confirm normalizes to "per_hour", diff triggers a 409).
 */
export function normalizePayTypeInPlace(input: any): void {
  if (!input || typeof input !== "object") return;
  const raw = input.pay_type;
  if (typeof raw !== "string") return;
  const key = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
  const ALIASES: Record<string, string> = {
    "hourly": "per_hour",
    "per_hour": "per_hour",
    "hour": "per_hour",
    "per_hr": "per_hour",
    "transaction": "per_transaction",
    "per_transaction": "per_transaction",
    "per_tx": "per_transaction",
    "tx": "per_transaction",
    "commission": "percentage_of_revenue",
    "percentage_of_revenue": "percentage_of_revenue",
    "percent_of_revenue": "percentage_of_revenue",
    "revenue_share": "percentage_of_revenue",
    "annual": "annual",
    "salary": "annual",
    "yearly": "annual",
    "per_year": "annual",
  };
  const mapped = ALIASES[key];
  if (mapped && mapped !== raw) {
    input.pay_type = mapped;
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Misc small helpers also shared
// ─────────────────────────────────────────────────────────────────────────

/** Clamp a limit param to [1, 50], default 20. */
export function clampLimit(n: any): number {
  const v = typeof n === "number" ? n : parseInt(n);
  if (!Number.isFinite(v) || v <= 0) return 20;
  return Math.min(v, 50);
}
