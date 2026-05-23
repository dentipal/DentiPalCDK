/**
 * Tool definitions for the DentiPal Bedrock AgentCore agents.
 *
 * Buckets (matches the plan):
 *   info     - read-only lookups
 *   search   - discovery queries
 *   response - writes (always pair preview_* with confirm_*)
 *   audit    - "what did I do recently" queries
 *
 * The AgentCore CfnAgent action group function-schema mirror lives in the
 * CDK stack file; keep this catalog in sync when adding tools.
 */

export type ToolBucket = "info" | "search" | "response" | "audit";
export type AgentScope = "clinic" | "professional" | "both";

/**
 * Pre/post normalizer tags. Matches the switch in
 * chat-gateway/wrapperDispatch.ts → runPreNormalizers / runPostNormalizers.
 * Adding a new tag here also requires a case in that switch.
 */
export type GatewayNormalizer =
  | "clinicIds"
  | "professionalRole"
  | "dates"
  | "payTypeAlias"
  | "applicationStatusFilter"
  | "dayDateRangeFilter"
  | "actionableApplicants"
  | "trimPastDates";

/**
 * Routing metadata for the AgentCore Gateway dispatcher. Tools without a
 * `gateway` field are visible to the model (the schema is still emitted)
 * but the dispatcher returns 501 if it ever sees one — useful for schemas
 * we want advertised but not yet implemented.
 *
 *   handlerModule  — file under lambda/src/handlers/ (no .ts). Special
 *                    markers: "__preview__" for preview_* tools (dispatcher
 *                    handles inline, no handler call); "__ddbQuery__" for
 *                    the generic DDB escape hatch.
 *   method         — HTTP method the underlying handler reads from the
 *                    synthetic API-Gateway event.
 *   inputShape     — where the input maps:
 *                      body          → JSON body
 *                      path          → pathParameters[pathParamKey]
 *                      query         → queryStringParameters (stringified)
 *                      pathAndBody   → pathParamKey to path, rest to body
 *   pathParamKey   — required for "path" / "pathAndBody".
 *   preNormalizers — run on input BEFORE the handler call.
 *   postNormalizers — run on response BEFORE returning to the agent.
 */
export interface GatewayRouting {
  handlerModule: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  inputShape: "body" | "path" | "query" | "pathAndBody";
  pathParamKey?: string;
  preNormalizers?: GatewayNormalizer[];
  postNormalizers?: GatewayNormalizer[];
}

export interface ToolDefinition {
  name: string;
  bucket: ToolBucket;
  scope: AgentScope;
  description: string;
  inputSchema: Record<string, any>;
  pairedPreview?: string;
  /** Optional — present when the tool is wired through AgentCore Gateway
   *  (WS-3). When absent, dispatcher returns 501. */
  gateway?: GatewayRouting;
}

const NUMBER = { type: "number" };
const STRING = { type: "string" };
const BOOL = { type: "boolean" };
const STRING_ARRAY = { type: "array", items: { type: "string" } };
// Mirror of VALID_PAY_TYPES in createTemporaryJob / createMultiDayConsulting /
// createPermanentJob handlers. Without this enum the agent LLM guesses
// values like "hourly" / "salary" and the handler rejects with
// `Invalid pay type`; on retry the new `per_hour` value differs from the
// previewed `hourly`, tripping the previewGate diff guard. Enum keeps the
// agent on the rails on the first call.
const PAY_TYPE_ENUM = { type: "string", enum: ["per_hour", "per_transaction", "percentage_of_revenue"] };

// =========================================================================
// PROFESSIONAL AGENT TOOLS
// =========================================================================

export const SEARCH_JOBS_NEAR_ME: ToolDefinition = {
  name: "search_jobs_near_me", bucket: "search", scope: "professional",
  description:
    "Find active job postings matching filters. Use whenever the user wants to discover jobs. " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) for queries like 'jobs on Monday'; " +
    "pass `dateFrom`/`dateTo` (YYYY-MM-DD) for explicit date windows. Server filters — do NOT filter results yourself.",
  inputSchema: {
    type: "object",
    properties: {
      radiusMiles: NUMBER, jobType: STRING, professionalRole: STRING, shiftSpeciality: STRING,
      minRate: NUMBER, maxRate: NUMBER, dateFrom: STRING, dateTo: STRING,
      dayOfWeek: STRING,
      assistedHygiene: BOOL, limit: NUMBER,
    },
  },
  gateway: {
    handlerModule: "getProfessionalFilteredJobs", method: "GET", inputShape: "query",
    postNormalizers: ["trimPastDates", "dayDateRangeFilter"],
  },
};

export const GET_JOB_DETAILS: ToolDefinition = {
  // CLINIC-ONLY: handler getJobPosting.ts keys by (clinicUserSub=caller, jobId),
  // so only the clinic that owns the posting can fetch it. Professionals see
  // the same job data via search_jobs_near_me result cards, so exposing this
  // to the pro agent just produces "Job not found or access denied" 500s
  // before an apply flow. Scope flipped from "both" to "clinic".
  name: "get_job_details", bucket: "info", scope: "clinic",
  description: "Get full details for a job by jobId. Clinic-only — the caller must be the clinic that posted the job.",
  inputSchema: { type: "object", required: ["jobId"], properties: { jobId: STRING } },
  gateway: { handlerModule: "getJobPosting", method: "GET", inputShape: "path", pathParamKey: "jobId" },
};

export const GET_MY_APPLICATIONS: ToolDefinition = {
  name: "get_my_applications", bucket: "info", scope: "professional",
  description:
    "List the professional's applications. " +
    "Pass `status` to scope to one tab: 'pending' (pending + negotiating — anything awaiting clinic action), " +
    "'scheduled' (accepted/hired/confirmed), 'completed', 'no_show', 'rejected' (rejected/declined/canceled). " +
    "Omit `status` to return EVERY application across all statuses (use this only for 'show me all my applications'). " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) or `dateFrom`/`dateTo` (YYYY-MM-DD) to filter by shift date. Server filters.",
  inputSchema: {
    type: "object",
    properties: {
      status: { type: "string", enum: ["pending", "scheduled", "completed", "no_show", "rejected"] },
      dayOfWeek: STRING, dateFrom: STRING, dateTo: STRING,
    },
  },
  gateway: {
    handlerModule: "getJobApplications", method: "GET", inputShape: "query",
    postNormalizers: ["applicationStatusFilter", "dayDateRangeFilter"],
  },
};

export const GET_MY_INVITATIONS: ToolDefinition = {
  name: "get_my_invitations", bucket: "info", scope: "professional",
  description:
    "List the professional's pending clinic invitations (excludes accepted/declined/past). " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) or `dateFrom`/`dateTo` (YYYY-MM-DD) " +
    "to filter by the underlying shift's date. Server filters.",
  inputSchema: {
    type: "object",
    properties: { dayOfWeek: STRING, dateFrom: STRING, dateTo: STRING },
  },
  gateway: {
    handlerModule: "getJobInvitations", method: "GET", inputShape: "query",
    postNormalizers: ["dayDateRangeFilter"],
  },
};

export const GET_SCHEDULED_SHIFTS: ToolDefinition = {
  name: "get_scheduled_shifts", bucket: "info", scope: "both",
  description:
    "List accepted, future shifts. Pro sees their own; clinic sees theirs. " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) for 'shifts on Monday' queries; " +
    "`dateFrom`/`dateTo` (YYYY-MM-DD) for explicit date windows. Server filters.",
  inputSchema: {
    type: "object",
    properties: { clinicId: STRING, dayOfWeek: STRING, dateFrom: STRING, dateTo: STRING },
  },
  gateway: {
    handlerModule: "getScheduledShifts", method: "GET", inputShape: "path",
    pathParamKey: "clinicId", postNormalizers: ["dayDateRangeFilter"],
  },
};

export const GET_COMPLETED_SHIFTS: ToolDefinition = {
  name: "get_completed_shifts", bucket: "info", scope: "both",
  description:
    "List completed shifts. Pro sees their own; clinic sees theirs. " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) or `dateFrom`/`dateTo` (YYYY-MM-DD) " +
    "for day-of-week or date-window filtering. Server filters.",
  inputSchema: {
    type: "object",
    properties: { clinicId: STRING, dayOfWeek: STRING, dateFrom: STRING, dateTo: STRING },
  },
  gateway: {
    handlerModule: "getCompletedShifts", method: "GET", inputShape: "path",
    pathParamKey: "clinicId", postNormalizers: ["dayDateRangeFilter"],
  },
};

export const GET_MY_NEGOTIATIONS: ToolDefinition = {
  name: "get_my_negotiations", bucket: "info", scope: "professional",
  description: "List all of the professional's open negotiations.",
  inputSchema: { type: "object", properties: {} },
  gateway: { handlerModule: "getAllNegotiations-Prof", method: "GET", inputShape: "query" },
};

export const APPLY_TO_JOB: ToolDefinition = {
  name: "apply_to_job", bucket: "response", scope: "professional",
  description: "Single-shot apply. Required: jobId. No preview, no rate, no questions.",
  inputSchema: {
    type: "object", required: ["jobId"],
    properties: {
      jobId: STRING,
      message: STRING,
      startDate: STRING,
      notes: STRING,
    },
  },
  gateway: {
    handlerModule: "createJobApplication", method: "POST",
    inputShape: "pathAndBody", pathParamKey: "jobId",
  },
};

export const RESPOND_INVITATION: ToolDefinition = {
  name: "respond_invitation", bucket: "response", scope: "professional",
  description: "Accept or decline a clinic invitation. response must be 'accepted' or 'declined'. For counter-offers, use preview_negotiate.",
  inputSchema: {
    type: "object", required: ["invitationId", "response"],
    properties: {
      invitationId: STRING,
      response: { type: "string", enum: ["accepted", "declined"] },
      message: STRING,
    },
  },
  gateway: {
    handlerModule: "respondToInvitation", method: "POST",
    inputShape: "pathAndBody", pathParamKey: "invitationId",
  },
};

export const PREVIEW_APPLY_TO_JOB: ToolDefinition = {
  name: "preview_apply_to_job", bucket: "response", scope: "professional",
  description: "Render a confirm-card for applying to a job. Does NOT submit.",
  inputSchema: {
    type: "object", required: ["jobId", "message", "proposedRate", "availability"],
    properties: {
      jobId: STRING, message: STRING, proposedRate: NUMBER, availability: STRING,
      startDate: STRING, notes: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_APPLY_TO_JOB: ToolDefinition = {
  name: "confirm_apply_to_job", bucket: "response", scope: "professional",
  pairedPreview: "preview_apply_to_job",
  description: "Submit the application. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "message", "proposedRate", "availability"],
    properties: {
      previewToken: STRING, jobId: STRING, message: STRING, proposedRate: NUMBER,
      availability: STRING, startDate: STRING, notes: STRING,
    },
  },
  gateway: { handlerModule: "createJobApplication", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_RESPOND_INVITATION: ToolDefinition = {
  name: "preview_respond_invitation", bucket: "response", scope: "professional",
  description: "Render confirm-card for accepting/declining/negotiating an invitation.",
  inputSchema: {
    type: "object", required: ["invitationId", "response"],
    properties: {
      invitationId: STRING,
      response: { type: "string", enum: ["accepted", "declined", "negotiating"] },
      message: STRING, proposedHourlyRate: NUMBER,
      proposedSalaryMin: NUMBER, proposedSalaryMax: NUMBER,
      availabilityNotes: STRING, counterProposalMessage: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_RESPOND_INVITATION: ToolDefinition = {
  name: "confirm_respond_invitation", bucket: "response", scope: "professional",
  pairedPreview: "preview_respond_invitation",
  description: "Send the invitation response. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "invitationId", "response"],
    properties: {
      previewToken: STRING, invitationId: STRING, response: STRING,
      message: STRING, proposedHourlyRate: NUMBER, proposedSalaryMin: NUMBER,
      proposedSalaryMax: NUMBER, availabilityNotes: STRING, counterProposalMessage: STRING,
    },
  },
  gateway: { handlerModule: "respondToInvitation", method: "POST", inputShape: "pathAndBody", pathParamKey: "invitationId" },
};

export const PREVIEW_WITHDRAW_APPLICATION: ToolDefinition = {
  name: "preview_withdraw_application", bucket: "response", scope: "professional",
  description: "Render confirm-card for withdrawing an application.",
  inputSchema: { type: "object", required: ["applicationId"], properties: { applicationId: STRING, reason: STRING } },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_WITHDRAW_APPLICATION: ToolDefinition = {
  name: "confirm_withdraw_application", bucket: "response", scope: "professional",
  pairedPreview: "preview_withdraw_application",
  description: "Withdraw the application. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "applicationId"],
    properties: { previewToken: STRING, applicationId: STRING, reason: STRING },
  },
  gateway: { handlerModule: "deleteJobApplication", method: "DELETE", inputShape: "path", pathParamKey: "applicationId" },
};

// --- PRO Phase 4: standalone negotiate, attest, profile, address, notifications, feedback, referral ---

export const PREVIEW_NEGOTIATE_PRO: ToolDefinition = {
  name: "preview_negotiate", bucket: "response", scope: "both",
  description: "Render confirm-card for sending a counter-offer / accept / decline on an existing negotiation round. Both pros (counter clinic) and clinics (counter pro) use this same tool.",
  inputSchema: {
    type: "object", required: ["applicationId", "negotiationId", "response"],
    properties: {
      applicationId: STRING, negotiationId: STRING,
      response: { type: "string", enum: ["accepted", "declined", "counter_offer"] },
      message: STRING,
      clinicCounterRate: NUMBER, professionalCounterRate: NUMBER,
      counterSalaryMin: NUMBER, counterSalaryMax: NUMBER,
      payType: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_NEGOTIATE_PRO: ToolDefinition = {
  name: "confirm_negotiate", bucket: "response", scope: "both",
  pairedPreview: "preview_negotiate",
  description: "Send the negotiation response. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "applicationId", "negotiationId", "response"],
    properties: {
      previewToken: STRING, applicationId: STRING, negotiationId: STRING,
      response: STRING, message: STRING,
      clinicCounterRate: NUMBER, professionalCounterRate: NUMBER,
      counterSalaryMin: NUMBER, counterSalaryMax: NUMBER,
      payType: STRING,
    },
  },
  gateway: { handlerModule: "respondToNegotiation", method: "PUT", inputShape: "pathAndBody", pathParamKey: "applicationId" },
};

export const PREVIEW_ATTEST_COMPLETED_SHIFT: ToolDefinition = {
  name: "preview_attest_completed_shift", bucket: "response", scope: "professional",
  description: "Render confirm-card for the professional's post-shift attestation.",
  inputSchema: {
    type: "object", required: ["jobId", "attestedHours", "signedAt"],
    properties: {
      jobId: STRING, attestedHours: NUMBER, attestedRate: NUMBER,
      signedAt: STRING, notes: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_ATTEST_COMPLETED_SHIFT: ToolDefinition = {
  name: "confirm_attest_completed_shift", bucket: "response", scope: "professional",
  pairedPreview: "preview_attest_completed_shift",
  description: "Submit the attestation. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "attestedHours", "signedAt"],
    properties: {
      previewToken: STRING, jobId: STRING, attestedHours: NUMBER, attestedRate: NUMBER,
      signedAt: STRING, notes: STRING,
    },
  },
  gateway: { handlerModule: "updateCompletedShifts", method: "PUT", inputShape: "body" },
};

export const PREVIEW_UPDATE_MY_PROFILE: ToolDefinition = {
  name: "preview_update_my_profile", bucket: "response", scope: "professional",
  description: "Render confirm-card for updating the pro's profile. Pass only fields to change.",
  inputSchema: {
    type: "object",
    properties: {
      first_name: STRING, last_name: STRING, role: STRING,
      specialties: STRING_ARRAY, bio: STRING,
      years_experience: NUMBER, license_number: STRING, license_state: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_UPDATE_MY_PROFILE: ToolDefinition = {
  name: "confirm_update_my_profile", bucket: "response", scope: "professional",
  pairedPreview: "preview_update_my_profile",
  description: "Apply the profile update. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken"],
    properties: {
      previewToken: STRING,
      first_name: STRING, last_name: STRING, role: STRING,
      specialties: STRING_ARRAY, bio: STRING,
      years_experience: NUMBER, license_number: STRING, license_state: STRING,
    },
  },
  gateway: { handlerModule: "updateProfessionalProfile", method: "PUT", inputShape: "body" },
};

export const PREVIEW_UPDATE_HOME_ADDRESS: ToolDefinition = {
  name: "preview_update_home_address", bucket: "response", scope: "professional",
  description: "Render confirm-card for updating the pro's home address. Used for radius search.",
  inputSchema: {
    type: "object", required: ["addressLine1", "city", "state", "pincode"],
    properties: {
      addressLine1: STRING, addressLine2: STRING, addressLine3: STRING,
      city: STRING, state: STRING, pincode: STRING, country: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_UPDATE_HOME_ADDRESS: ToolDefinition = {
  name: "confirm_update_home_address", bucket: "response", scope: "professional",
  pairedPreview: "preview_update_home_address",
  description: "Save the home address. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "addressLine1", "city", "state", "pincode"],
    properties: {
      previewToken: STRING,
      addressLine1: STRING, addressLine2: STRING, addressLine3: STRING,
      city: STRING, state: STRING, pincode: STRING, country: STRING,
    },
  },
  gateway: { handlerModule: "updateUserAddress", method: "PUT", inputShape: "body" },
};

export const PREVIEW_UPDATE_NOTIFICATION_PREFS: ToolDefinition = {
  name: "preview_update_notification_preferences", bucket: "response", scope: "both",
  description: "Render confirm-card for updating notification preferences (email/SMS/push toggles).",
  inputSchema: {
    type: "object",
    properties: {
      emailEnabled: BOOL, smsEnabled: BOOL, pushEnabled: BOOL,
      jobInvitations: BOOL, applicationUpdates: BOOL,
      negotiationUpdates: BOOL, shiftReminders: BOOL,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_UPDATE_NOTIFICATION_PREFS: ToolDefinition = {
  name: "confirm_update_notification_preferences", bucket: "response", scope: "both",
  pairedPreview: "preview_update_notification_preferences",
  description: "Save notification preferences. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken"],
    properties: {
      previewToken: STRING,
      emailEnabled: BOOL, smsEnabled: BOOL, pushEnabled: BOOL,
      jobInvitations: BOOL, applicationUpdates: BOOL,
      negotiationUpdates: BOOL, shiftReminders: BOOL,
    },
  },
  gateway: { handlerModule: "updateNotificationPreferences", method: "PUT", inputShape: "body" },
};

export const PREVIEW_SUBMIT_FEEDBACK: ToolDefinition = {
  name: "preview_submit_feedback", bucket: "response", scope: "both",
  description: "Render confirm-card for submitting feedback / dispute about a clinic, professional, or shift.",
  inputSchema: {
    type: "object", required: ["feedback", "type"],
    properties: {
      type: STRING, feedback: STRING, rating: NUMBER,
      targetUserSub: STRING, targetClinicId: STRING, jobId: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_SUBMIT_FEEDBACK: ToolDefinition = {
  name: "confirm_submit_feedback", bucket: "response", scope: "both",
  pairedPreview: "preview_submit_feedback",
  description: "Submit the feedback. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "feedback", "type"],
    properties: {
      previewToken: STRING, type: STRING, feedback: STRING, rating: NUMBER,
      targetUserSub: STRING, targetClinicId: STRING, jobId: STRING,
    },
  },
  gateway: { handlerModule: "submitFeedback", method: "POST", inputShape: "body" },
};

export const PREVIEW_SEND_REFERRAL: ToolDefinition = {
  name: "preview_send_referral", bucket: "response", scope: "professional",
  description: "Render confirm-card for inviting another professional via email.",
  inputSchema: {
    type: "object", required: ["referredEmail", "referredName"],
    properties: { referredEmail: STRING, referredName: STRING, message: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_SEND_REFERRAL: ToolDefinition = {
  name: "confirm_send_referral", bucket: "response", scope: "professional",
  pairedPreview: "preview_send_referral",
  description: "Send the referral invite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "referredEmail", "referredName"],
    properties: { previewToken: STRING, referredEmail: STRING, referredName: STRING, message: STRING },
  },
  gateway: { handlerModule: "sendReferralInvite", method: "POST", inputShape: "body" },
};

// =========================================================================
// CLINIC AGENT TOOLS
// =========================================================================

export const GET_MY_CLINICS: ToolDefinition = {
  name: "get_my_clinics", bucket: "info", scope: "clinic",
  description: "List the clinics the current user manages. Use BEFORE post_*_job to pick clinicId(s).",
  inputSchema: { type: "object", properties: {} },
  gateway: { handlerModule: "getUsersClinics", method: "GET", inputShape: "query" },
};

export const GET_ACTION_NEEDED: ToolDefinition = {
  name: "get_action_needed", bucket: "info", scope: "clinic",
  description: "List items needing the clinic's action — pending applications, open negotiations.",
  inputSchema: { type: "object", required: ["clinicId"], properties: { clinicId: STRING } },
  gateway: { handlerModule: "getActionNeeded", method: "GET", inputShape: "path", pathParamKey: "clinicId" },
};

export const GET_SENT_INVITATIONS: ToolDefinition = {
  // Aggregated "invitations I have sent" across every clinic the user
  // manages. Composed virtual handler in the dispatcher (fans out
  // getUsersClinics -> getClinicShifts per clinic -> JobInvitations
  // jobId-index per job). Returns {invitations:[...]} so the existing
  // InvitationsList card renders unchanged with per-card actions.
  //
  // PREFER over query_ddb_table: JobInvitations has no clinicId GSI so a
  // naive query_ddb_table by clinicId fails with "key not allowed".
  name: "get_sent_invitations", bucket: "info", scope: "clinic",
  description:
    "List all invitations the clinic admin has sent across every clinic they manage, newest first. " +
    "Use for 'show my sent invitations', 'invitations I sent', 'pending invitations to professionals', etc. " +
    "Returns {invitations:[...]} with each row tagged by clinicName, jobTitle, professional role. " +
    "PREFER this over query_ddb_table on JobInvitations -- the JobInvitations table has no clinic-scoped GSI.",
  inputSchema: { type: "object", properties: {} },
  gateway: { handlerModule: "getSentInvitations", method: "GET", inputShape: "query" },
};

export const GET_MY_POSTED_JOBS: ToolDefinition = {
  // Unified jobs query for the clinic agent. Replaces both the original
  // "all my jobs" aggregator AND the per-clinic get_open_shifts tool.
  //
  // Without clinicId: fans out across every clinic the user manages, returns
  //   the union of active + future-dated postings (one row per posting,
  //   matches dashboard's "open jobs" count).
  // With clinicId:    same filter, scoped to that single clinic.
  //
  // The composed dispatcher handler (case "getMyPostedJobs") honours the
  // optional clinicId by limiting the fan-out to that one clinic when
  // present.
  name: "get_my_posted_jobs", bucket: "info", scope: "clinic",
  description:
    "List active future-dated job postings. By default returns jobs across EVERY clinic the user manages. " +
    "Pass `clinicId` to narrow to one clinic (e.g. 'show open jobs at Qwerty Clinic'). " +
    "Pass `dayOfWeek` (mon|tue|wed|thu|fri|sat|sun) to filter to shifts on a specific weekday " +
    "(e.g. 'open shifts on Thursday'). " +
    "Pass `dateFrom`/`dateTo` (YYYY-MM-DD inclusive) for an explicit date window " +
    "(e.g. 'jobs next week' -> dateFrom=2026-05-26, dateTo=2026-06-01). " +
    "Returns {jobs:[...]} with clinicName tagged on each row. Use for 'show my jobs', 'open jobs', " +
    "'available shifts', 'recent postings', etc. -- ONE call regardless of how many clinics the user manages.",
  inputSchema: {
    type: "object",
    properties: {
      clinicId: STRING,
      dayOfWeek: STRING,
      dateFrom: STRING,
      dateTo: STRING,
    },
  },
  gateway: { handlerModule: "getMyPostedJobs", method: "GET", inputShape: "query", postNormalizers: ["dayDateRangeFilter"] },
};

export const GET_OPEN_SHIFTS: ToolDefinition = {
  name: "get_open_shifts", bucket: "info", scope: "clinic",
  description:
    "List upcoming unfilled shifts for a clinic. Optional filters: " +
    "`dayOfWeek` (mon|tue|wed|thu|fri|sat|sun — case-insensitive, full names also accepted) " +
    "to restrict to a specific weekday; " +
    "`dateFrom`/`dateTo` (YYYY-MM-DD inclusive) for an explicit date window. " +
    "When the user asks 'open shifts for Monday' / 'Thursday' etc., pass dayOfWeek; do NOT filter results yourself.",
  inputSchema: {
    type: "object",
    required: ["clinicId"],
    properties: {
      clinicId: STRING,
      dayOfWeek: STRING,
      dateFrom: STRING,
      dateTo: STRING,
    },
  },
  gateway: { handlerModule: "getClinicShifts", method: "GET", inputShape: "path", pathParamKey: "clinicId", postNormalizers: ["trimPastDates", "dayDateRangeFilter"] },
};

export const LIST_APPLICANTS_FOR_JOB: ToolDefinition = {
  name: "list_applicants_for_job", bucket: "info", scope: "clinic",
  description: "List applicants for a specific clinic's job.",
  inputSchema: {
    type: "object", required: ["clinicId"],
    properties: { clinicId: STRING, jobId: STRING },
  },
  gateway: { handlerModule: "getJobApplicantsOfAClinic", method: "GET", inputShape: "path", pathParamKey: "clinicId", postNormalizers: ["actionableApplicants"] },
};

export const GET_PROFESSIONAL_INFO: ToolDefinition = {
  name: "get_professional_info", bucket: "info", scope: "clinic",
  description: "Get a professional's public profile by userSub.",
  inputSchema: { type: "object", required: ["userSub"], properties: { userSub: STRING } },
  gateway: { handlerModule: "getPublicProfessionalProfile", method: "GET", inputShape: "path", pathParamKey: "userSub" },
};

export const GET_CLINIC_FAVORITES: ToolDefinition = {
  name: "get_clinic_favorites", bucket: "info", scope: "clinic",
  description: "List professionals the clinic has marked as favorites.",
  inputSchema: { type: "object", properties: {} },
  gateway: { handlerModule: "getClinicFavorites", method: "GET", inputShape: "query" },
};

export const PREVIEW_POST_TEMPORARY_JOB: ToolDefinition = {
  name: "preview_post_temporary_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a single-shift temp job posting. ALWAYS preview before confirm. You MUST ask the clinic how many professionals they need for the shift (`positions_required`, integer 1-20) before calling this tool — do not assume 1.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "date", "shift_speciality", "hours", "rate", "start_time", "end_time", "positions_required", "work_location_type"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      date: STRING, shift_speciality: STRING, hours: NUMBER, rate: NUMBER,
      pay_type: PAY_TYPE_ENUM, start_time: STRING, end_time: STRING, meal_break: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      assisted_hygiene: BOOL,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "payTypeAlias"] },
};

export const CONFIRM_POST_TEMPORARY_JOB: ToolDefinition = {
  name: "confirm_post_temporary_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_temporary_job",
  description: "Create the temp job posting. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "date", "shift_speciality", "hours", "rate", "start_time", "end_time", "positions_required", "work_location_type"],
    properties: {
      previewToken: STRING,
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      date: STRING, shift_speciality: STRING, hours: NUMBER, rate: NUMBER,
      pay_type: PAY_TYPE_ENUM, start_time: STRING, end_time: STRING, meal_break: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      assisted_hygiene: BOOL,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "createTemporaryJob", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "payTypeAlias"] },
};

export const PREVIEW_POST_CONSULTING_JOB: ToolDefinition = {
  name: "preview_post_consulting_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a multi-day consulting job posting. You MUST ask the clinic how many professionals they need (`positions_required`, 1-20) AND the work mode (`work_location_type`: onsite | us_remote | global_remote) before calling this tool — do not assume defaults.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "dates", "total_days", "hours_per_day", "shift_speciality", "rate", "start_time", "end_time", "positions_required", "work_location_type"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      dates: STRING_ARRAY, total_days: NUMBER, hours_per_day: NUMBER,
      shift_speciality: STRING, rate: NUMBER, pay_type: PAY_TYPE_ENUM,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      project_duration: STRING, job_title: STRING, job_description: STRING,
      requirements: STRING_ARRAY,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "dates", "payTypeAlias"] },
};

export const CONFIRM_POST_CONSULTING_JOB: ToolDefinition = {
  name: "confirm_post_consulting_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_consulting_job",
  description: "Create the consulting job. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "dates", "total_days", "hours_per_day", "shift_speciality", "rate", "start_time", "end_time", "positions_required", "work_location_type"],
    properties: {
      previewToken: STRING, clinicIds: STRING_ARRAY, professional_role: STRING,
      professional_roles: STRING_ARRAY, dates: STRING_ARRAY, total_days: NUMBER,
      hours_per_day: NUMBER, shift_speciality: STRING, rate: NUMBER, pay_type: PAY_TYPE_ENUM,
      start_time: STRING, end_time: STRING, meal_break: STRING, project_duration: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "createMultiDayConsulting", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "dates", "payTypeAlias"] },
};

export const PREVIEW_POST_PERMANENT_JOB: ToolDefinition = {
  name: "preview_post_permanent_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a permanent job posting. You MUST ask the clinic how many professionals they want to hire (`positions_required`, 1-20) AND the work mode (`work_location_type`: onsite | us_remote | global_remote) before calling this tool — do not assume defaults.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "shift_speciality", "employment_type", "benefits", "positions_required", "work_location_type"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      shift_speciality: STRING,
      employment_type: { type: "string", enum: ["full_time", "part_time"] },
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      vacation_days: NUMBER, work_schedule: STRING, start_date: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      pay_type: PAY_TYPE_ENUM, rate: NUMBER, positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "payTypeAlias"] },
};

export const CONFIRM_POST_PERMANENT_JOB: ToolDefinition = {
  name: "confirm_post_permanent_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_permanent_job",
  description: "Create the permanent job. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "shift_speciality", "employment_type", "benefits", "positions_required", "work_location_type"],
    properties: {
      previewToken: STRING, clinicIds: STRING_ARRAY, professional_role: STRING,
      professional_roles: STRING_ARRAY, shift_speciality: STRING,
      employment_type: STRING, salary_min: NUMBER, salary_max: NUMBER,
      benefits: STRING_ARRAY, vacation_days: NUMBER, work_schedule: STRING,
      start_date: STRING, job_title: STRING, job_description: STRING,
      requirements: STRING_ARRAY,
      work_location_type: { type: "string", enum: ["onsite", "us_remote", "global_remote"] },
      pay_type: PAY_TYPE_ENUM, rate: NUMBER, positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "createPermanentJob", method: "POST", inputShape: "body", preNormalizers: ["clinicIds", "professionalRole", "payTypeAlias"] },
};

export const PREVIEW_ACCEPT_PROFESSIONAL: ToolDefinition = {
  name: "preview_accept_professional", bucket: "response", scope: "clinic",
  description: "Render confirm-card for hiring a professional onto a job.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSub"],
    properties: { jobId: STRING, professionalUserSub: STRING, acceptedRate: NUMBER, message: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_ACCEPT_PROFESSIONAL: ToolDefinition = {
  name: "confirm_accept_professional", bucket: "response", scope: "clinic",
  pairedPreview: "preview_accept_professional",
  description: "Accept (hire) the professional. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSub"],
    properties: { previewToken: STRING, jobId: STRING, professionalUserSub: STRING, acceptedRate: NUMBER, message: STRING },
  },
  gateway: { handlerModule: "acceptProf", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_REJECT_PROFESSIONAL: ToolDefinition = {
  name: "preview_reject_professional", bucket: "response", scope: "clinic",
  description: "Render confirm-card for rejecting an applicant.",
  inputSchema: {
    type: "object", required: ["clinicId", "jobId", "professionalUserSub"],
    properties: { clinicId: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_REJECT_PROFESSIONAL: ToolDefinition = {
  name: "confirm_reject_professional", bucket: "response", scope: "clinic",
  pairedPreview: "preview_reject_professional",
  description: "Reject the applicant. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "clinicId", "jobId", "professionalUserSub"],
    properties: { previewToken: STRING, clinicId: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING },
  },
  gateway: { handlerModule: "rejectProf", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_SEND_INVITATIONS: ToolDefinition = {
  name: "preview_send_invitations", bucket: "response", scope: "clinic",
  description: "Render confirm-card for inviting professionals to a job.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSubs"],
    properties: {
      jobId: STRING, professionalUserSubs: STRING_ARRAY,
      invitationMessage: STRING,
      urgency: { type: "string", enum: ["low", "medium", "high"] },
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_SEND_INVITATIONS: ToolDefinition = {
  name: "confirm_send_invitations", bucket: "response", scope: "clinic",
  pairedPreview: "preview_send_invitations",
  description: "Send the invitations. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSubs"],
    properties: {
      previewToken: STRING, jobId: STRING, professionalUserSubs: STRING_ARRAY,
      invitationMessage: STRING, urgency: STRING,
    },
  },
  gateway: { handlerModule: "sendJobInvitations", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

// --- Clinic Phase 4: mark-completed, no-show, profile, edit/cancel, favorites, team, search-pros ---

export const PREVIEW_MARK_SHIFT_COMPLETED: ToolDefinition = {
  name: "preview_mark_shift_completed", bucket: "response", scope: "clinic",
  description: "Render confirm-card for the clinic's post-shift completion attestation.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSub", "attestedHours"],
    properties: {
      jobId: STRING, professionalUserSub: STRING,
      attestedHours: NUMBER, attestedRate: NUMBER, clinicNotes: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_MARK_SHIFT_COMPLETED: ToolDefinition = {
  name: "confirm_mark_shift_completed", bucket: "response", scope: "clinic",
  pairedPreview: "preview_mark_shift_completed",
  description: "Confirm shift completion. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSub", "attestedHours"],
    properties: {
      previewToken: STRING, jobId: STRING, professionalUserSub: STRING,
      attestedHours: NUMBER, attestedRate: NUMBER, clinicNotes: STRING,
    },
  },
  gateway: { handlerModule: "confirmShiftCompletion", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_REPORT_NO_SHOW: ToolDefinition = {
  name: "preview_report_no_show", bucket: "response", scope: "clinic",
  description: "Render confirm-card for reporting a professional no-show.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSub", "reason"],
    properties: { jobId: STRING, professionalUserSub: STRING, reason: STRING, details: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_REPORT_NO_SHOW: ToolDefinition = {
  name: "confirm_report_no_show", bucket: "response", scope: "clinic",
  pairedPreview: "preview_report_no_show",
  description: "Submit the no-show report. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSub", "reason"],
    properties: { previewToken: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING, details: STRING },
  },
  gateway: { handlerModule: "reportNoShow", method: "POST", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_UPDATE_CLINIC_PROFILE: ToolDefinition = {
  name: "preview_update_clinic_profile", bucket: "response", scope: "clinic",
  description: "Render confirm-card for clinic profile edits. Pass only fields to change.",
  inputSchema: {
    type: "object", required: ["clinicId"],
    properties: {
      clinicId: STRING,
      clinic_name: STRING, clinic_type: STRING, practice_type: STRING,
      primary_practice_area: STRING,
      primary_contact_first_name: STRING, primary_contact_last_name: STRING,
      assisted_hygiene_available: BOOL,
      number_of_operatories: NUMBER, num_hygienists: NUMBER, num_assistants: NUMBER, num_doctors: NUMBER,
      booking_out_period: STRING, clinic_software: STRING, software_used: STRING_ARRAY,
      parking_type: STRING, parking_cost: NUMBER, free_parking_available: BOOL,
      addressLine1: STRING, addressLine2: STRING, addressLine3: STRING,
      city: STRING, state: STRING, zipCode: STRING,
      contact_email: STRING, contact_phone: STRING,
      special_requirements: STRING_ARRAY, notes: STRING, description: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_UPDATE_CLINIC_PROFILE: ToolDefinition = {
  name: "confirm_update_clinic_profile", bucket: "response", scope: "clinic",
  pairedPreview: "preview_update_clinic_profile",
  description: "Save clinic profile edits. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "clinicId"],
    properties: {
      previewToken: STRING, clinicId: STRING,
      clinic_name: STRING, clinic_type: STRING, practice_type: STRING,
      primary_practice_area: STRING,
      primary_contact_first_name: STRING, primary_contact_last_name: STRING,
      assisted_hygiene_available: BOOL,
      number_of_operatories: NUMBER, num_hygienists: NUMBER, num_assistants: NUMBER, num_doctors: NUMBER,
      booking_out_period: STRING, clinic_software: STRING, software_used: STRING_ARRAY,
      parking_type: STRING, parking_cost: NUMBER, free_parking_available: BOOL,
      addressLine1: STRING, addressLine2: STRING, addressLine3: STRING,
      city: STRING, state: STRING, zipCode: STRING,
      contact_email: STRING, contact_phone: STRING,
      special_requirements: STRING_ARRAY, notes: STRING, description: STRING,
    },
  },
  gateway: { handlerModule: "updateClinicProfile", method: "PUT", inputShape: "pathAndBody", pathParamKey: "clinicId" },
};

export const PREVIEW_EDIT_JOB: ToolDefinition = {
  name: "preview_edit_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for editing an existing job posting. Pass only fields to change. `positions_required` (1-20) is the hiring headcount; raising it on a filled job reopens it for more hires; lowering it below positions already filled is rejected.",
  inputSchema: {
    type: "object", required: ["jobId"],
    properties: {
      jobId: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      hours: NUMBER, rate: NUMBER, pay_type: PAY_TYPE_ENUM,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      date: STRING, dates: STRING_ARRAY, hours_per_day: NUMBER, total_days: NUMBER,
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      employment_type: STRING, vacation_days: NUMBER, work_schedule: STRING,
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_EDIT_JOB: ToolDefinition = {
  name: "confirm_edit_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_edit_job",
  description: "Apply the job edits. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId"],
    properties: {
      previewToken: STRING, jobId: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      hours: NUMBER, rate: NUMBER, pay_type: PAY_TYPE_ENUM,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      date: STRING, dates: STRING_ARRAY, hours_per_day: NUMBER, total_days: NUMBER,
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      employment_type: STRING, vacation_days: NUMBER, work_schedule: STRING,
      positions_required: NUMBER,
    },
  },
  gateway: { handlerModule: "updateJobPosting", method: "PUT", inputShape: "pathAndBody", pathParamKey: "jobId" },
};

export const PREVIEW_CANCEL_JOB: ToolDefinition = {
  name: "preview_cancel_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for cancelling/deactivating a job posting.",
  inputSchema: {
    type: "object", required: ["jobId"],
    properties: { jobId: STRING, reason: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_CANCEL_JOB: ToolDefinition = {
  name: "confirm_cancel_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_cancel_job",
  description: "Mark the job inactive. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId"],
    properties: { previewToken: STRING, jobId: STRING, reason: STRING },
  },
  // Routes to cancelJobByType composed handler (looks up job_type, fans
  // out to deleteTemporaryJob or deletePermanentJob). updateJobStatus
  // doesn't support cancellation -- it only validates lifecycle
  // transitions (open/scheduled/action_needed/completed).
  gateway: { handlerModule: "cancelJobByType", method: "DELETE", inputShape: "path", pathParamKey: "jobId" },
};

export const PREVIEW_ADD_CLINIC_FAVORITE: ToolDefinition = {
  name: "preview_add_clinic_favorite", bucket: "response", scope: "clinic",
  description: "Render confirm-card for adding a professional to the clinic's favorites.",
  inputSchema: {
    type: "object", required: ["professionalUserSub"],
    properties: { professionalUserSub: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_ADD_CLINIC_FAVORITE: ToolDefinition = {
  name: "confirm_add_clinic_favorite", bucket: "response", scope: "clinic",
  pairedPreview: "preview_add_clinic_favorite",
  description: "Save the favorite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "professionalUserSub"],
    properties: { previewToken: STRING, professionalUserSub: STRING },
  },
  gateway: { handlerModule: "addClinicFavorite", method: "POST", inputShape: "body" },
};

export const PREVIEW_REMOVE_CLINIC_FAVORITE: ToolDefinition = {
  name: "preview_remove_clinic_favorite", bucket: "response", scope: "clinic",
  description: "Render confirm-card for removing a professional from favorites.",
  inputSchema: {
    type: "object", required: ["professionalUserSub"],
    properties: { professionalUserSub: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_REMOVE_CLINIC_FAVORITE: ToolDefinition = {
  name: "confirm_remove_clinic_favorite", bucket: "response", scope: "clinic",
  pairedPreview: "preview_remove_clinic_favorite",
  description: "Remove the favorite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "professionalUserSub"],
    properties: { previewToken: STRING, professionalUserSub: STRING },
  },
  gateway: { handlerModule: "removeClinicFavorite", method: "DELETE", inputShape: "path", pathParamKey: "professionalUserSub" },
};

export const SEARCH_PROFESSIONALS: ToolDefinition = {
  name: "search_professionals", bucket: "search", scope: "clinic",
  description: "Find professionals by role/specialty. Use BEFORE preview_send_invitations to pick targets.",
  inputSchema: {
    type: "object",
    properties: { role: STRING, speciality: STRING, limit: NUMBER },
  },
  gateway: { handlerModule: "getAllProfessionals", method: "GET", inputShape: "query" },
};

export const PREVIEW_INVITE_TEAM_MEMBER: ToolDefinition = {
  name: "preview_invite_team_member", bucket: "response", scope: "clinic",
  description: "Render confirm-card for inviting a teammate (ClinicManager/ClinicViewer) to a clinic.",
  inputSchema: {
    type: "object", required: ["clinicId", "email", "role"],
    properties: {
      clinicId: STRING, email: STRING,
      role: { type: "string", enum: ["ClinicManager", "ClinicViewer"] },
      first_name: STRING, last_name: STRING,
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_INVITE_TEAM_MEMBER: ToolDefinition = {
  name: "confirm_invite_team_member", bucket: "response", scope: "clinic",
  pairedPreview: "preview_invite_team_member",
  description: "Send the team invite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "clinicId", "email", "role"],
    properties: {
      previewToken: STRING, clinicId: STRING, email: STRING, role: STRING,
      first_name: STRING, last_name: STRING,
    },
  },
  gateway: { handlerModule: "createAssignment", method: "POST", inputShape: "body" },
};

export const PREVIEW_UPDATE_TEAM_MEMBER: ToolDefinition = {
  name: "preview_update_team_member", bucket: "response", scope: "clinic",
  description: "Render confirm-card for changing a teammate's role.",
  inputSchema: {
    type: "object", required: ["userSub", "clinicId", "role"],
    properties: {
      userSub: STRING, clinicId: STRING,
      role: { type: "string", enum: ["ClinicAdmin", "ClinicManager", "ClinicViewer"] },
    },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_UPDATE_TEAM_MEMBER: ToolDefinition = {
  name: "confirm_update_team_member", bucket: "response", scope: "clinic",
  pairedPreview: "preview_update_team_member",
  description: "Save the role change. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "userSub", "clinicId", "role"],
    properties: { previewToken: STRING, userSub: STRING, clinicId: STRING, role: STRING },
  },
  gateway: { handlerModule: "updateAssignment", method: "PUT", inputShape: "body" },
};

export const PREVIEW_REMOVE_TEAM_MEMBER: ToolDefinition = {
  name: "preview_remove_team_member", bucket: "response", scope: "clinic",
  description: "Render confirm-card for removing a teammate from a clinic.",
  inputSchema: {
    type: "object", required: ["userSub", "clinicId"],
    properties: { userSub: STRING, clinicId: STRING },
  },
  gateway: { handlerModule: "__preview__", method: "POST", inputShape: "body" },
};

export const CONFIRM_REMOVE_TEAM_MEMBER: ToolDefinition = {
  name: "confirm_remove_team_member", bucket: "response", scope: "clinic",
  pairedPreview: "preview_remove_team_member",
  description: "Remove the teammate. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "userSub", "clinicId"],
    properties: { previewToken: STRING, userSub: STRING, clinicId: STRING },
  },
  gateway: { handlerModule: "deleteAssignment", method: "DELETE", inputShape: "query" },
};

// =========================================================================
// Generic DDB read (escape hatch — see ddbQueryTool.ts and plan
// make-a-comprehensive-table-joyful-pearl.md). One tool shared by both
// authenticated agents; explicitly NOT available to the public agent.
// =========================================================================

export const QUERY_DDB_TABLE: ToolDefinition = {
  name: "query_ddb_table", bucket: "info", scope: "both",
  description:
    "FALLBACK reader for analytics / diagnostic / cross-cut questions the narrow tools don't cover " +
    "(e.g., 'how many applications did I make last month', 'look up application by id', " +
    "'compare pending applicants across my clinics'). " +
    "ALWAYS prefer narrow tools (get_my_applications, get_scheduled_shifts, list_applicants_for_job, etc.) " +
    "when one fits. NEVER use for writes — those have dedicated preview_*/confirm_* tools. " +
    "Allowed tables: JobPostings, JobApplications, JobInvitations, JobNegotiations, " +
    "ProfessionalProfiles, ClinicProfiles. Server FORCES auth scoping — you cannot read another user's data. " +
    "op = query (multiple rows) or getItem (single row by full key). " +
    "keyName / indexName must match an allowed key on that table; see error message for the allow-list if you guess wrong.",
  inputSchema: {
    type: "object",
    required: ["table", "op", "keyName", "keyValue"],
    properties: {
      table: STRING,        // one of the 6 allow-listed short names (omit DentiPal-V5- prefix)
      op: STRING,           // "query" | "getItem"
      indexName: STRING,    // optional GSI name; tool can usually infer from keyName
      keyName: STRING,      // attribute used as the partition key
      keyValue: STRING,     // partition key value
      sortKeyName: STRING,
      sortKeyValue: STRING,
      sortKeyValueEnd: STRING,
      sortKeyOp: STRING,    // "=" | "begins_with" | ">" | ">=" | "<" | "<=" | "between"
      filterStatus: STRING,
      filterDateFrom: STRING,
      filterDateTo: STRING,
      limit: NUMBER,        // 1-50, default 25
    },
  },
  gateway: { handlerModule: "__ddbQuery__", method: "POST", inputShape: "body" },
};

// =========================================================================
// Registries
// =========================================================================

export const PROFESSIONAL_AGENT_TOOLS: ToolDefinition[] = [
  SEARCH_JOBS_NEAR_ME, GET_JOB_DETAILS, GET_MY_APPLICATIONS, GET_MY_INVITATIONS,
  GET_SCHEDULED_SHIFTS, GET_COMPLETED_SHIFTS, GET_MY_NEGOTIATIONS,
  // Escape hatch — see ddbQueryTool.ts. Use only when narrow tools above don't fit.
  QUERY_DDB_TABLE,
  // Single-shot writes (v1 active set)
  APPLY_TO_JOB, RESPOND_INVITATION,
  // Counter-offer preview/confirm (v1 active set)
  PREVIEW_NEGOTIATE_PRO, CONFIRM_NEGOTIATE_PRO,
  // Legacy preview/confirm pairs — kept in registry so the executor can still
  // dispatch them if invoked, but NOT advertised to the model (filtered out
  // by PRO_V1_FUNCTIONS in the CDK CfnAgent definition).
  PREVIEW_APPLY_TO_JOB, CONFIRM_APPLY_TO_JOB,
  PREVIEW_RESPOND_INVITATION, CONFIRM_RESPOND_INVITATION,
  PREVIEW_WITHDRAW_APPLICATION, CONFIRM_WITHDRAW_APPLICATION,
  PREVIEW_ATTEST_COMPLETED_SHIFT, CONFIRM_ATTEST_COMPLETED_SHIFT,
  PREVIEW_UPDATE_MY_PROFILE, CONFIRM_UPDATE_MY_PROFILE,
  PREVIEW_UPDATE_HOME_ADDRESS, CONFIRM_UPDATE_HOME_ADDRESS,
  PREVIEW_UPDATE_NOTIFICATION_PREFS, CONFIRM_UPDATE_NOTIFICATION_PREFS,
  PREVIEW_SUBMIT_FEEDBACK, CONFIRM_SUBMIT_FEEDBACK,
  PREVIEW_SEND_REFERRAL, CONFIRM_SEND_REFERRAL,
];

export const CLINIC_AGENT_TOOLS: ToolDefinition[] = [
  GET_MY_CLINICS, GET_MY_POSTED_JOBS, GET_SENT_INVITATIONS, GET_ACTION_NEEDED, GET_SCHEDULED_SHIFTS,
  // GET_OPEN_SHIFTS removed: get_my_posted_jobs now subsumes it (accepts
  // optional clinicId + dayOfWeek + dateFrom/dateTo filters). One tool for
  // both "show all my jobs" and "open shifts on Thursday at clinic X".
  GET_COMPLETED_SHIFTS, LIST_APPLICANTS_FOR_JOB, GET_PROFESSIONAL_INFO,
  GET_CLINIC_FAVORITES, GET_JOB_DETAILS,
  // Escape hatch — see ddbQueryTool.ts. Use only when narrow tools above don't fit.
  QUERY_DDB_TABLE,
  PREVIEW_POST_TEMPORARY_JOB, CONFIRM_POST_TEMPORARY_JOB,
  PREVIEW_POST_CONSULTING_JOB, CONFIRM_POST_CONSULTING_JOB,
  PREVIEW_POST_PERMANENT_JOB, CONFIRM_POST_PERMANENT_JOB,
  PREVIEW_ACCEPT_PROFESSIONAL, CONFIRM_ACCEPT_PROFESSIONAL,
  PREVIEW_REJECT_PROFESSIONAL, CONFIRM_REJECT_PROFESSIONAL,
  PREVIEW_SEND_INVITATIONS, CONFIRM_SEND_INVITATIONS,
  // Phase 4
  PREVIEW_NEGOTIATE_PRO, CONFIRM_NEGOTIATE_PRO, // shared with pro
  PREVIEW_MARK_SHIFT_COMPLETED, CONFIRM_MARK_SHIFT_COMPLETED,
  PREVIEW_REPORT_NO_SHOW, CONFIRM_REPORT_NO_SHOW,
  PREVIEW_UPDATE_CLINIC_PROFILE, CONFIRM_UPDATE_CLINIC_PROFILE,
  PREVIEW_EDIT_JOB, CONFIRM_EDIT_JOB,
  PREVIEW_CANCEL_JOB, CONFIRM_CANCEL_JOB,
  PREVIEW_ADD_CLINIC_FAVORITE, CONFIRM_ADD_CLINIC_FAVORITE,
  PREVIEW_REMOVE_CLINIC_FAVORITE, CONFIRM_REMOVE_CLINIC_FAVORITE,
  SEARCH_PROFESSIONALS,
  PREVIEW_INVITE_TEAM_MEMBER, CONFIRM_INVITE_TEAM_MEMBER,
  PREVIEW_UPDATE_TEAM_MEMBER, CONFIRM_UPDATE_TEAM_MEMBER,
  PREVIEW_REMOVE_TEAM_MEMBER, CONFIRM_REMOVE_TEAM_MEMBER,
  PREVIEW_SUBMIT_FEEDBACK, CONFIRM_SUBMIT_FEEDBACK, // shared
  PREVIEW_UPDATE_NOTIFICATION_PREFS, CONFIRM_UPDATE_NOTIFICATION_PREFS, // shared
];

export const ALL_TOOLS: ToolDefinition[] = [
  ...PROFESSIONAL_AGENT_TOOLS,
  ...CLINIC_AGENT_TOOLS,
];

export function getToolDefinition(name: string): ToolDefinition | undefined {
  return ALL_TOOLS.find(t => t.name === name);
}
