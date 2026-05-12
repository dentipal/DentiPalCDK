import { AuthContext } from "../utils";
import { haversineDistance } from "../geo";
import { runBrowseJobPostings, BrowseJobPostingsInput } from "../browseJobPostings";
import { runGetJobInvitations } from "../getJobInvitations";
import { runCreateJobApplication, CreateJobApplicationInput } from "../createJobApplication-prof";

// Adapter for un-refactored handlers
import { callHandlerInProcess } from "./handlerAdapter";
import { handler as createJobApplicationHandler } from "../createJobApplication"; // REST apply (NOT the -prof variant)
import { handler as getJobPostingHandler } from "../getJobPosting";
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

function clampLimit(n: any): number {
  const v = typeof n === "number" ? n : parseInt(n);
  if (!Number.isFinite(v) || v <= 0) return 20;
  return Math.min(v, 50);
}

/**
 * Normalize whatever shape the model passed for clinic identifiers into a
 * proper `clinicIds: string[]` of UUIDs on the input object. Tolerates:
 *   - `clinicId` singular → wrap to array
 *   - comma-separated string → split
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
  const raw = input.clinicIds ?? input.clinicId;
  let arr: string[] | undefined;
  if (Array.isArray(raw)) arr = raw as string[];
  else if (typeof raw === "string") arr = raw.split(",").map((s: string) => s.trim()).filter(Boolean);
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
  if (result.status >= 400) return err(toolName, result.status, JSON.stringify(result.body));
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

  try {
    switch (call.toolName) {
      // ------------------- PROFESSIONAL: search / info -------------------
      case "search_jobs_near_me": {
        // Over-fetch then trim post-filter, since the radius cut may remove
        // most of the page.
        const requestedLimit = clampLimit(call.input.limit);
        const input: BrowseJobPostingsInput = {
          jobType: call.input.jobType, professionalRole: call.input.professionalRole,
          shiftSpeciality: call.input.shiftSpeciality, minRate: call.input.minRate,
          maxRate: call.input.maxRate, dateFrom: call.input.dateFrom, dateTo: call.input.dateTo,
          assistedHygiene: call.input.assistedHygiene,
          limit: Math.min(requestedLimit * 4, 200),
        };
        const r = await runBrowseJobPostings(input, auth);
        if (r.status >= 400) return err(call.toolName, r.status, JSON.stringify(r.body));

        let postings: any[] = r.body?.jobPostings || [];
        const home = userContext?.home;
        const radiusMiles = typeof call.input.radiusMiles === "number" && call.input.radiusMiles > 0
          ? call.input.radiusMiles
          : 50;

        if (home && typeof home.lat === "number" && typeof home.lng === "number") {
          // Annotate every posting with miles-from-home, drop those without
          // coords or outside the radius, then sort nearest first.
          postings = postings
            .map((p) => {
              if (typeof p?.lat === "number" && typeof p?.lng === "number") {
                const miles = haversineDistance(home.lat, home.lng, p.lat, p.lng);
                return { ...p, distanceMiles: Math.round(miles * 10) / 10 };
              }
              return null;
            })
            .filter((p): p is any => p !== null && p.distanceMiles <= radiusMiles)
            .sort((a, b) => a.distanceMiles - b.distanceMiles);
        }

        postings = postings.slice(0, requestedLimit);
        const enrichedBody = {
          ...r.body,
          jobPostings: postings,
          totalCount: postings.length,
          radiusMiles: home ? radiusMiles : null,
          filteredByDistance: !!home,
        };

        await setRecentSearchResults(auth.userSub, connectionId, postings.slice(0, 20));
        return ok(call.toolName, enrichedBody);
      }
      case "get_job_details": {
        const r = await callHandlerInProcess(getJobPostingHandler, {
          method: "GET", pathParameters: { jobId: call.input.jobId }, auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_my_applications": {
        const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_my_invitations": {
        const r = await runGetJobInvitations(auth);
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_my_negotiations": {
        const r = await callHandlerInProcess(getAllNegotiationsProfHandler, { method: "GET", auth });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_scheduled_shifts": {
        // Pros: filter their own applications by upcoming/scheduled status.
        // Clinics: use the clinic-side handler with their clinicId.
        const isPro = (auth.userType || "").toLowerCase().startsWith("prof");
        if (isPro || !call.input.clinicId) {
          const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
          if (r.status >= 400) return err(call.toolName, r.status, JSON.stringify(r.body));
          const apps = Array.isArray(r.body?.applications) ? r.body.applications
                       : Array.isArray(r.body) ? r.body : [];
          const scheduled = apps.filter((a: any) => {
            const s = (a.applicationStatus || a.status || "").toLowerCase();
            return s === "accepted" || s === "scheduled";
          });
          return ok(call.toolName, { applications: scheduled, totalCount: scheduled.length, source: "professional" });
        }
        const r = await callHandlerInProcess(getScheduledShiftsHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId },
          auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_completed_shifts": {
        const isPro = (auth.userType || "").toLowerCase().startsWith("prof");
        if (isPro || !call.input.clinicId) {
          const r = await callHandlerInProcess(getJobApplicationsHandler, { method: "GET", auth });
          if (r.status >= 400) return err(call.toolName, r.status, JSON.stringify(r.body));
          const apps = Array.isArray(r.body?.applications) ? r.body.applications
                       : Array.isArray(r.body) ? r.body : [];
          const completed = apps.filter((a: any) => {
            const s = (a.applicationStatus || a.status || "").toLowerCase();
            return s === "completed";
          });
          return ok(call.toolName, { applications: completed, totalCount: completed.length, source: "professional" });
        }
        const r = await callHandlerInProcess(getCompletedShiftsHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId },
          auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
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
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
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
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }

      // ------------------- PROFESSIONAL: legacy preview/confirm pairs (kept for back-compat) -------------------
      case "preview_apply_to_job":
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!i.jobId || typeof i.jobId !== "string") return "jobId is required";
          if (!i.message) return "message is required";
          if (typeof i.proposedRate !== "number" || i.proposedRate <= 0) return "proposedRate must be a positive number";
          if (!i.availability) return "availability is required";
          return null;
        });
      case "confirm_apply_to_job":
        return genericConfirm(call.toolName, auth, connectionId, call.input, async (p) => {
          const input: CreateJobApplicationInput = {
            message: p.message, proposedRate: p.proposedRate, availability: p.availability,
            startDate: p.startDate, notes: p.notes,
          };
          return runCreateJobApplication(p.jobId, input, auth);
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
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_action_needed": {
        const r = await callHandlerInProcess(getActionNeededHandler, {
          method: "GET", pathParameters: { clinicId: call.input.clinicId }, auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_open_shifts": {
        const r = await callHandlerInProcess(getClinicShiftsHandler, {
          method: "GET", pathParameters: { clinicId: call.input.clinicId }, auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "list_applicants_for_job": {
        const r = await callHandlerInProcess(getJobApplicantsOfAClinicHandler, {
          method: "GET",
          pathParameters: { clinicId: call.input.clinicId },
          queryStringParameters: call.input.jobId ? { jobId: call.input.jobId } : undefined,
          auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_professional_info": {
        const r = await callHandlerInProcess(getPublicProfessionalProfileHandler, {
          method: "GET", pathParameters: { userSub: call.input.userSub }, auth,
        });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }
      case "get_clinic_favorites": {
        const r = await callHandlerInProcess(getClinicFavoritesHandler, { method: "GET", auth });
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
      }

      // ------------------- CLINIC: response (preview/confirm) -------------------
      case "preview_post_temporary_job":
        normalizeClinicIdsInPlace(call.input, userContext);
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
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(createTemporaryJobHandler, { method: "POST", body: p, auth }),
        );

      case "preview_post_consulting_job":
        normalizeClinicIdsInPlace(call.input, userContext);
        return genericPreview(call.toolName, auth, connectionId, call.input, (i) => {
          if (!Array.isArray(i.clinicIds) || i.clinicIds.length === 0) return "clinicIds required (array of UUIDs)";
          if (!Array.isArray(i.dates) || i.dates.length === 0) return "dates required";
          if (typeof i.total_days !== "number") return "total_days required";
          if (typeof i.hours_per_day !== "number") return "hours_per_day required";
          return null;
        });
      case "confirm_post_consulting_job":
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(createMultiDayConsultingHandler, { method: "POST", body: p, auth }),
        );

      case "preview_post_permanent_job":
        normalizeClinicIdsInPlace(call.input, userContext);
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
        return genericConfirm(call.toolName, auth, connectionId, call.input, (p) =>
          callHandlerInProcess(createPermanentJobHandler, { method: "POST", body: p, auth }),
        );

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
        return r.status >= 400 ? err(call.toolName, r.status, JSON.stringify(r.body)) : ok(call.toolName, r.body);
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
