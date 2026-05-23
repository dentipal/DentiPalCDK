import { AuthContext } from "../utils";
import { haversineDistance } from "../geo";
import { runBrowseJobPostings } from "../browseJobPostings";
import { runGetJobInvitations } from "../getJobInvitations";
// All input/output normalization helpers live in a shared module so the
// Bedrock Agents path (this file) and the AgentCore Gateway wrapper
// Lambdas (../chat-gateway/wrappers/*) stay in lockstep. Improvements to a
// normalizer benefit both call sites automatically.
import {
  trimPastDatesFromPostings,
  filterShiftsByDayAndDateRange,
  filterApplicationsByStatusInResult,
  filterApplicantsToActionableInResult,
  normalizeDayOfWeek,
  normalizeDatesInPlace,
  normalizeProfessionalRoleInPlace,
  normalizeRoleToDbValue,
  normalizeClinicIdsInPlace,
  clampLimit,
} from "../chat-gateway/normalizers";
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
  setRecentSearchResults,
  getSessionByConnectionId,
} from "./sessionStore";
import { runQueryDdbTable, QueryDdbInput } from "./ddbQueryTool";
import { verifyPreviewBeforeConfirm, clearPreviewAfterConfirm } from "./previewGate";
import { putPreview } from "./previewGateStore";
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

// ---------------------------------------------------------------------
// All input/output normalization helpers used to live here and were lifted
// into ../chat-gateway/normalizers.ts during WS-3 so they can be shared by
// both this executor and the Gateway wrapper Lambdas. See the import block
// at the top of this file for the full set.
// ---------------------------------------------------------------------

// ---------- Generic preview/confirm helpers ----------

/** Standard "render confirm card" preview tool — validates payload, stores it, returns the card.
 *
 * `connectionId` is accepted for caller-signature stability but no longer
 * used internally: the preview row now lives in the dedicated PreviewGates
 * table keyed by (userSub, previewToken), so the WebSocket connection
 * identity is irrelevant to gate enforcement. Leaving the param in keeps
 * the per-tool switch arms unchanged and gives WS-5 room to pass a
 * conversationId once it threads one through.
 */
async function genericPreview(
  toolName: string,
  auth: AuthContext,
  _connectionId: string,
  input: Record<string, any>,
  validate?: (i: Record<string, any>) => string | null,
): Promise<ToolResult> {
  if (validate) {
    const v = validate(input);
    if (v) return err(toolName, 400, v);
  }
  const previewToken = await putPreview({
    userSub: auth.userSub,
    toolName,
    payload: input,
  });
  return ok(toolName, {
    kind: "confirm_card",
    action: toolName.replace(/^preview_/, ""),
    previewToken,
    fields: input,
    warnings: [],
    confirmTool: toolName.replace(/^preview_/, "confirm_"),
  });
}

/** Standard "verify gate then execute" confirm tool. See genericPreview's
 *  doc for why `_connectionId` is kept for shape but unused. */
async function genericConfirm(
  toolName: string,
  auth: AuthContext,
  _connectionId: string,
  input: Record<string, any>,
  exec: (payloadWithoutToken: Record<string, any>) => Promise<{ status: number; body: any }>,
): Promise<ToolResult> {
  const { previewToken, ...payload } = input;
  const gate = await verifyPreviewBeforeConfirm(auth.userSub, toolName, previewToken, payload);
  if (!gate.ok) return err(toolName, gate.status, gate.reason);
  const result = await exec(payload);
  // Burn the row only after a successful business call. A failed downstream
  // (validation, DDB throttle, etc.) leaves the token alive so the user can
  // retry the same confirm without going back through preview.
  if (result.status >= 400) return err(toolName, result.status, safeBodyToString(result.status, result.body));
  await clearPreviewAfterConfirm(auth.userSub, previewToken);
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

        // Past-date hygiene runs first so downstream day-of-week filtering and
        // the card renderer both see upcoming-only dates. Without it, multi-day
        // postings whose first occurrence is past kept rendering "Sun · 17 May"
        // even when the next occurrence was a week away.
        let finalPostings = trimPastDatesFromPostings(postings);

        // If the canonical handler didn't apply distance (no home coords),
        // do a best-effort Haversine on what we got.
        if (home?.lat && home?.lng) {
          finalPostings = finalPostings.map((p: any) => {
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
        // Map the requested status bucket onto the underlying applicationStatus
        // values. The professional dashboard groups statuses into tabs;
        // "pending" tab = pending + negotiating (anything the pro is still
        // waiting on); "scheduled" = scheduled/accepted/hired/confirmed;
        // "completed" = completed; "no_show" = no_show; "rejected" =
        // rejected/declined/canceled. The agent passes the bucket name; we
        // expand it here so the LLM never has to know the internal status
        // alphabet.
        const STATUS_BUCKETS: Record<string, string[]> = {
          pending: ["pending", "negotiating"],
          scheduled: ["scheduled", "accepted", "hired", "confirmed"],
          completed: ["completed"],
          no_show: ["no_show", "no-show"],
          rejected: ["rejected", "declined", "canceled"],
        };
        const statusInput = (call.input.status || "").toString().toLowerCase().trim();
        const allowed = STATUS_BUCKETS[statusInput];
        const filteredByStatus = allowed ? filterApplicationsByStatusInResult(r, allowed) : r;
        const filtered = filterShiftsByDayAndDateRange(filteredByStatus, {
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
        // getClinicShiftsHandler is a tab-switched endpoint: routes off
        // event.pathParameters.proxy (REST path's trailing segment). Without
        // proxy="open-shifts" the handler returns data:[].
        const r = await callHandlerInProcess(getClinicShiftsHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId, proxy: "open-shifts" },
          auth,
        });
        // Default dateFrom to today so past-dated postings don't surface as
        // "open". The underlying handler considers any active, unfilled
        // posting as open regardless of date — but a clinic asking "open
        // shifts" or "open shifts on monday" means upcoming, not historical.
        // Respect an explicit dateFrom if the model passed one (e.g. user
        // said "open shifts last week"). For multi-day shifts, the filter
        // already keeps the row if ANY of its dates falls in range, so a
        // shift with some past + some future dates still appears.
        const todayIso = new Date().toISOString().slice(0, 10);
        const effectiveDateFrom = call.input.dateFrom || todayIso;
        const filtered = filterShiftsByDayAndDateRange(r, {
          dayOfWeek: call.input.dayOfWeek,
          dateFrom: effectiveDateFrom,
          dateTo: call.input.dateTo,
        });
        if (filtered.status >= 400) {
          return err(call.toolName, filtered.status, safeBodyToString(filtered.status, filtered.body));
        }
        // Reshape to {shifts: [...], totalCount} so the chat widget renders
        // JobResultsList WITHOUT the apply-checkbox CTA (see ResultCards.tsx:
        // the `shifts` branch passes no onSendApply, so the "Apply to N"
        // affordance is hidden — correct for clinic-side, since clinics
        // OWN these postings rather than applying to them).
        //
        // The handler returns {message, data: [array]} which the widget
        // doesn't know how to display — that's why the agent appeared to
        // say "Done." with no cards even when the handler returned dozens.
        const shifts: any[] = Array.isArray(filtered.body?.data) ? filtered.body.data : [];
        // Defense-in-depth: getClinicShifts.open-shifts has no past-date filter
        // of its own, so a temp posting whose `date` has passed but whose status
        // still reads `active` would surface here as "open". Trim past dates
        // and drop fully-past postings so the chat card never shows them.
        const trimmedShifts = trimPastDatesFromPostings(shifts);
        return ok(call.toolName, {
          shifts: trimmedShifts,
          totalCount: trimmedShifts.length,
        });
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
          // createPermanentJob is the unified create handler; it requires
          // job_type in the body. The chat tool schema never asks the LLM
          // for it because the tool name already implies it.
          return callHandlerInProcess(createPermanentJobHandler, { method: "POST", body: { ...p, job_type: "permanent" }, auth });
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

      // ------------------- ESCAPE HATCH: generic DDB read -------------------
      // Use only when no narrow tool fits. See ddbQueryTool.ts and the plan
      // make-a-comprehensive-table-joyful-pearl.md. Auth scoping, PII
      // redaction, and the table allow-list are all enforced inside
      // runQueryDdbTable — this case is just plumbing.
      case "query_ddb_table": {
        const session = await getSessionByConnectionId(connectionId);
        if (!session) return err(call.toolName, 410, "session_expired");
        const r = await runQueryDdbTable(call.input as QueryDdbInput, auth, session);
        if (!r.ok) return err(call.toolName, r.status, r.error);
        return ok(call.toolName, r.data);
      }

      default:
        return err(call.toolName, 501, `Tool '${call.toolName}' not wired up`);
    }
  } catch (e: any) {
    console.error(`executeTool('${call.toolName}') threw:`, e);
    return err(call.toolName, 500, e?.message || "Tool execution failed");
  }
}

