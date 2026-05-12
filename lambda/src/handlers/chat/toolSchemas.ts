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

export interface ToolDefinition {
  name: string;
  bucket: ToolBucket;
  scope: AgentScope;
  description: string;
  inputSchema: Record<string, any>;
  pairedPreview?: string;
}

const NUMBER = { type: "number" };
const STRING = { type: "string" };
const BOOL = { type: "boolean" };
const STRING_ARRAY = { type: "array", items: { type: "string" } };

// =========================================================================
// PROFESSIONAL AGENT TOOLS
// =========================================================================

export const SEARCH_JOBS_NEAR_ME: ToolDefinition = {
  name: "search_jobs_near_me", bucket: "search", scope: "professional",
  description: "Find active job postings matching filters. Use whenever the user wants to discover jobs.",
  inputSchema: {
    type: "object",
    properties: {
      radiusMiles: NUMBER, jobType: STRING, professionalRole: STRING, shiftSpeciality: STRING,
      minRate: NUMBER, maxRate: NUMBER, dateFrom: STRING, dateTo: STRING,
      assistedHygiene: BOOL, limit: NUMBER,
    },
  },
};

export const GET_JOB_DETAILS: ToolDefinition = {
  name: "get_job_details", bucket: "info", scope: "both",
  description: "Get full details for a job by jobId.",
  inputSchema: { type: "object", required: ["jobId"], properties: { jobId: STRING } },
};

export const GET_MY_APPLICATIONS: ToolDefinition = {
  name: "get_my_applications", bucket: "info", scope: "professional",
  description: "List the professional's applications and their statuses.",
  inputSchema: { type: "object", properties: {} },
};

export const GET_MY_INVITATIONS: ToolDefinition = {
  name: "get_my_invitations", bucket: "info", scope: "professional",
  description: "List the professional's pending clinic invitations (excludes accepted/declined/past).",
  inputSchema: { type: "object", properties: {} },
};

export const GET_SCHEDULED_SHIFTS: ToolDefinition = {
  name: "get_scheduled_shifts", bucket: "info", scope: "both",
  description: "List accepted, future shifts. Pro sees their own; clinic sees theirs.",
  inputSchema: { type: "object", properties: { clinicId: STRING } },
};

export const GET_COMPLETED_SHIFTS: ToolDefinition = {
  name: "get_completed_shifts", bucket: "info", scope: "both",
  description: "List completed shifts. Pro sees their own; clinic sees theirs.",
  inputSchema: { type: "object", properties: { clinicId: STRING } },
};

export const GET_MY_NEGOTIATIONS: ToolDefinition = {
  name: "get_my_negotiations", bucket: "info", scope: "professional",
  description: "List all of the professional's open negotiations.",
  inputSchema: { type: "object", properties: {} },
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
};

export const PREVIEW_WITHDRAW_APPLICATION: ToolDefinition = {
  name: "preview_withdraw_application", bucket: "response", scope: "professional",
  description: "Render confirm-card for withdrawing an application.",
  inputSchema: { type: "object", required: ["applicationId"], properties: { applicationId: STRING, reason: STRING } },
};

export const CONFIRM_WITHDRAW_APPLICATION: ToolDefinition = {
  name: "confirm_withdraw_application", bucket: "response", scope: "professional",
  pairedPreview: "preview_withdraw_application",
  description: "Withdraw the application. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "applicationId"],
    properties: { previewToken: STRING, applicationId: STRING, reason: STRING },
  },
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
};

export const PREVIEW_SEND_REFERRAL: ToolDefinition = {
  name: "preview_send_referral", bucket: "response", scope: "professional",
  description: "Render confirm-card for inviting another professional via email.",
  inputSchema: {
    type: "object", required: ["referredEmail", "referredName"],
    properties: { referredEmail: STRING, referredName: STRING, message: STRING },
  },
};

export const CONFIRM_SEND_REFERRAL: ToolDefinition = {
  name: "confirm_send_referral", bucket: "response", scope: "professional",
  pairedPreview: "preview_send_referral",
  description: "Send the referral invite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "referredEmail", "referredName"],
    properties: { previewToken: STRING, referredEmail: STRING, referredName: STRING, message: STRING },
  },
};

// =========================================================================
// CLINIC AGENT TOOLS
// =========================================================================

export const GET_MY_CLINICS: ToolDefinition = {
  name: "get_my_clinics", bucket: "info", scope: "clinic",
  description: "List the clinics the current user manages. Use BEFORE post_*_job to pick clinicId(s).",
  inputSchema: { type: "object", properties: {} },
};

export const GET_ACTION_NEEDED: ToolDefinition = {
  name: "get_action_needed", bucket: "info", scope: "clinic",
  description: "List items needing the clinic's action — pending applications, open negotiations.",
  inputSchema: { type: "object", required: ["clinicId"], properties: { clinicId: STRING } },
};

export const GET_OPEN_SHIFTS: ToolDefinition = {
  name: "get_open_shifts", bucket: "info", scope: "clinic",
  description: "List upcoming unfilled shifts for a clinic.",
  inputSchema: { type: "object", required: ["clinicId"], properties: { clinicId: STRING } },
};

export const LIST_APPLICANTS_FOR_JOB: ToolDefinition = {
  name: "list_applicants_for_job", bucket: "info", scope: "clinic",
  description: "List applicants for a specific clinic's job.",
  inputSchema: {
    type: "object", required: ["clinicId"],
    properties: { clinicId: STRING, jobId: STRING },
  },
};

export const GET_PROFESSIONAL_INFO: ToolDefinition = {
  name: "get_professional_info", bucket: "info", scope: "clinic",
  description: "Get a professional's public profile by userSub.",
  inputSchema: { type: "object", required: ["userSub"], properties: { userSub: STRING } },
};

export const GET_CLINIC_FAVORITES: ToolDefinition = {
  name: "get_clinic_favorites", bucket: "info", scope: "clinic",
  description: "List professionals the clinic has marked as favorites.",
  inputSchema: { type: "object", properties: {} },
};

export const PREVIEW_POST_TEMPORARY_JOB: ToolDefinition = {
  name: "preview_post_temporary_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a single-shift temp job posting. ALWAYS preview before confirm.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "date", "shift_speciality", "hours", "rate", "start_time", "end_time"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      date: STRING, shift_speciality: STRING, hours: NUMBER, rate: NUMBER,
      pay_type: STRING, start_time: STRING, end_time: STRING, meal_break: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      assisted_hygiene: BOOL, work_location_type: STRING,
    },
  },
};

export const CONFIRM_POST_TEMPORARY_JOB: ToolDefinition = {
  name: "confirm_post_temporary_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_temporary_job",
  description: "Create the temp job posting. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "date", "shift_speciality", "hours", "rate", "start_time", "end_time"],
    properties: {
      previewToken: STRING,
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      date: STRING, shift_speciality: STRING, hours: NUMBER, rate: NUMBER,
      pay_type: STRING, start_time: STRING, end_time: STRING, meal_break: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      assisted_hygiene: BOOL, work_location_type: STRING,
    },
  },
};

export const PREVIEW_POST_CONSULTING_JOB: ToolDefinition = {
  name: "preview_post_consulting_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a multi-day consulting job posting.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "dates", "total_days", "hours_per_day", "shift_speciality", "rate", "start_time", "end_time"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      dates: STRING_ARRAY, total_days: NUMBER, hours_per_day: NUMBER,
      shift_speciality: STRING, rate: NUMBER, pay_type: STRING,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      project_duration: STRING, job_title: STRING, job_description: STRING,
      requirements: STRING_ARRAY, work_location_type: STRING,
    },
  },
};

export const CONFIRM_POST_CONSULTING_JOB: ToolDefinition = {
  name: "confirm_post_consulting_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_consulting_job",
  description: "Create the consulting job. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "dates", "total_days", "hours_per_day", "shift_speciality", "rate", "start_time", "end_time"],
    properties: {
      previewToken: STRING, clinicIds: STRING_ARRAY, professional_role: STRING,
      professional_roles: STRING_ARRAY, dates: STRING_ARRAY, total_days: NUMBER,
      hours_per_day: NUMBER, shift_speciality: STRING, rate: NUMBER, pay_type: STRING,
      start_time: STRING, end_time: STRING, meal_break: STRING, project_duration: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY, work_location_type: STRING,
    },
  },
};

export const PREVIEW_POST_PERMANENT_JOB: ToolDefinition = {
  name: "preview_post_permanent_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for a permanent job posting.",
  inputSchema: {
    type: "object",
    required: ["clinicIds", "professional_role", "shift_speciality", "employment_type", "benefits"],
    properties: {
      clinicIds: STRING_ARRAY, professional_role: STRING, professional_roles: STRING_ARRAY,
      shift_speciality: STRING,
      employment_type: { type: "string", enum: ["full_time", "part_time"] },
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      vacation_days: NUMBER, work_schedule: STRING, start_date: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      work_location_type: STRING, pay_type: STRING, rate: NUMBER,
    },
  },
};

export const CONFIRM_POST_PERMANENT_JOB: ToolDefinition = {
  name: "confirm_post_permanent_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_post_permanent_job",
  description: "Create the permanent job. Requires previewToken.",
  inputSchema: {
    type: "object",
    required: ["previewToken", "clinicIds", "professional_role", "shift_speciality", "employment_type", "benefits"],
    properties: {
      previewToken: STRING, clinicIds: STRING_ARRAY, professional_role: STRING,
      professional_roles: STRING_ARRAY, shift_speciality: STRING,
      employment_type: STRING, salary_min: NUMBER, salary_max: NUMBER,
      benefits: STRING_ARRAY, vacation_days: NUMBER, work_schedule: STRING,
      start_date: STRING, job_title: STRING, job_description: STRING,
      requirements: STRING_ARRAY, work_location_type: STRING,
      pay_type: STRING, rate: NUMBER,
    },
  },
};

export const PREVIEW_ACCEPT_PROFESSIONAL: ToolDefinition = {
  name: "preview_accept_professional", bucket: "response", scope: "clinic",
  description: "Render confirm-card for hiring a professional onto a job.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSub"],
    properties: { jobId: STRING, professionalUserSub: STRING, acceptedRate: NUMBER, message: STRING },
  },
};

export const CONFIRM_ACCEPT_PROFESSIONAL: ToolDefinition = {
  name: "confirm_accept_professional", bucket: "response", scope: "clinic",
  pairedPreview: "preview_accept_professional",
  description: "Accept (hire) the professional. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSub"],
    properties: { previewToken: STRING, jobId: STRING, professionalUserSub: STRING, acceptedRate: NUMBER, message: STRING },
  },
};

export const PREVIEW_REJECT_PROFESSIONAL: ToolDefinition = {
  name: "preview_reject_professional", bucket: "response", scope: "clinic",
  description: "Render confirm-card for rejecting an applicant.",
  inputSchema: {
    type: "object", required: ["clinicId", "jobId", "professionalUserSub"],
    properties: { clinicId: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING },
  },
};

export const CONFIRM_REJECT_PROFESSIONAL: ToolDefinition = {
  name: "confirm_reject_professional", bucket: "response", scope: "clinic",
  pairedPreview: "preview_reject_professional",
  description: "Reject the applicant. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "clinicId", "jobId", "professionalUserSub"],
    properties: { previewToken: STRING, clinicId: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING },
  },
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
};

export const PREVIEW_REPORT_NO_SHOW: ToolDefinition = {
  name: "preview_report_no_show", bucket: "response", scope: "clinic",
  description: "Render confirm-card for reporting a professional no-show.",
  inputSchema: {
    type: "object", required: ["jobId", "professionalUserSub", "reason"],
    properties: { jobId: STRING, professionalUserSub: STRING, reason: STRING, details: STRING },
  },
};

export const CONFIRM_REPORT_NO_SHOW: ToolDefinition = {
  name: "confirm_report_no_show", bucket: "response", scope: "clinic",
  pairedPreview: "preview_report_no_show",
  description: "Submit the no-show report. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId", "professionalUserSub", "reason"],
    properties: { previewToken: STRING, jobId: STRING, professionalUserSub: STRING, reason: STRING, details: STRING },
  },
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
};

export const PREVIEW_EDIT_JOB: ToolDefinition = {
  name: "preview_edit_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for editing an existing job posting. Pass only fields to change.",
  inputSchema: {
    type: "object", required: ["jobId"],
    properties: {
      jobId: STRING,
      job_title: STRING, job_description: STRING, requirements: STRING_ARRAY,
      hours: NUMBER, rate: NUMBER, pay_type: STRING,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      date: STRING, dates: STRING_ARRAY, hours_per_day: NUMBER, total_days: NUMBER,
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      employment_type: STRING, vacation_days: NUMBER, work_schedule: STRING,
    },
  },
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
      hours: NUMBER, rate: NUMBER, pay_type: STRING,
      start_time: STRING, end_time: STRING, meal_break: STRING,
      date: STRING, dates: STRING_ARRAY, hours_per_day: NUMBER, total_days: NUMBER,
      salary_min: NUMBER, salary_max: NUMBER, benefits: STRING_ARRAY,
      employment_type: STRING, vacation_days: NUMBER, work_schedule: STRING,
    },
  },
};

export const PREVIEW_CANCEL_JOB: ToolDefinition = {
  name: "preview_cancel_job", bucket: "response", scope: "clinic",
  description: "Render confirm-card for cancelling/deactivating a job posting.",
  inputSchema: {
    type: "object", required: ["jobId"],
    properties: { jobId: STRING, reason: STRING },
  },
};

export const CONFIRM_CANCEL_JOB: ToolDefinition = {
  name: "confirm_cancel_job", bucket: "response", scope: "clinic",
  pairedPreview: "preview_cancel_job",
  description: "Mark the job inactive. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "jobId"],
    properties: { previewToken: STRING, jobId: STRING, reason: STRING },
  },
};

export const PREVIEW_ADD_CLINIC_FAVORITE: ToolDefinition = {
  name: "preview_add_clinic_favorite", bucket: "response", scope: "clinic",
  description: "Render confirm-card for adding a professional to the clinic's favorites.",
  inputSchema: {
    type: "object", required: ["professionalUserSub"],
    properties: { professionalUserSub: STRING },
  },
};

export const CONFIRM_ADD_CLINIC_FAVORITE: ToolDefinition = {
  name: "confirm_add_clinic_favorite", bucket: "response", scope: "clinic",
  pairedPreview: "preview_add_clinic_favorite",
  description: "Save the favorite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "professionalUserSub"],
    properties: { previewToken: STRING, professionalUserSub: STRING },
  },
};

export const PREVIEW_REMOVE_CLINIC_FAVORITE: ToolDefinition = {
  name: "preview_remove_clinic_favorite", bucket: "response", scope: "clinic",
  description: "Render confirm-card for removing a professional from favorites.",
  inputSchema: {
    type: "object", required: ["professionalUserSub"],
    properties: { professionalUserSub: STRING },
  },
};

export const CONFIRM_REMOVE_CLINIC_FAVORITE: ToolDefinition = {
  name: "confirm_remove_clinic_favorite", bucket: "response", scope: "clinic",
  pairedPreview: "preview_remove_clinic_favorite",
  description: "Remove the favorite. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "professionalUserSub"],
    properties: { previewToken: STRING, professionalUserSub: STRING },
  },
};

export const SEARCH_PROFESSIONALS: ToolDefinition = {
  name: "search_professionals", bucket: "search", scope: "clinic",
  description: "Find professionals by role/specialty. Use BEFORE preview_send_invitations to pick targets.",
  inputSchema: {
    type: "object",
    properties: { role: STRING, speciality: STRING, limit: NUMBER },
  },
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
};

export const CONFIRM_UPDATE_TEAM_MEMBER: ToolDefinition = {
  name: "confirm_update_team_member", bucket: "response", scope: "clinic",
  pairedPreview: "preview_update_team_member",
  description: "Save the role change. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "userSub", "clinicId", "role"],
    properties: { previewToken: STRING, userSub: STRING, clinicId: STRING, role: STRING },
  },
};

export const PREVIEW_REMOVE_TEAM_MEMBER: ToolDefinition = {
  name: "preview_remove_team_member", bucket: "response", scope: "clinic",
  description: "Render confirm-card for removing a teammate from a clinic.",
  inputSchema: {
    type: "object", required: ["userSub", "clinicId"],
    properties: { userSub: STRING, clinicId: STRING },
  },
};

export const CONFIRM_REMOVE_TEAM_MEMBER: ToolDefinition = {
  name: "confirm_remove_team_member", bucket: "response", scope: "clinic",
  pairedPreview: "preview_remove_team_member",
  description: "Remove the teammate. Requires previewToken.",
  inputSchema: {
    type: "object", required: ["previewToken", "userSub", "clinicId"],
    properties: { previewToken: STRING, userSub: STRING, clinicId: STRING },
  },
};

// =========================================================================
// Registries
// =========================================================================

export const PROFESSIONAL_AGENT_TOOLS: ToolDefinition[] = [
  SEARCH_JOBS_NEAR_ME, GET_JOB_DETAILS, GET_MY_APPLICATIONS, GET_MY_INVITATIONS,
  GET_SCHEDULED_SHIFTS, GET_COMPLETED_SHIFTS, GET_MY_NEGOTIATIONS,
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
  GET_MY_CLINICS, GET_ACTION_NEEDED, GET_OPEN_SHIFTS, GET_SCHEDULED_SHIFTS,
  GET_COMPLETED_SHIFTS, LIST_APPLICANTS_FOR_JOB, GET_PROFESSIONAL_INFO,
  GET_CLINIC_FAVORITES, GET_JOB_DETAILS,
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
