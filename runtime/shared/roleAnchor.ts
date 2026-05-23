/**
 * Role anchor system prompts.
 *
 * Lifted from the existing Bedrock Agents CfnAgent declarations in
 * lib/denti_pal_cdk-stack.ts (lines 3090-3381) so the runtime agents
 * behave identically to today on the model-instruction front. The only
 * change is dropping the "ROLE ANCHOR" preamble injection — LangGraph
 * carries the system prompt forward on every turn, so re-injecting in the
 * user message is redundant.
 *
 * Why anchors matter (verbatim from the WS-1/2 chatMessage docs): the LLM
 * has a tendency to drift between clinic-side and professional-side
 * framings when the conversation goes long. The anchor is a tight
 * one-paragraph guardrail re-asserting WHICH side the user is on and what
 * NOT to do — strong enough to survive long contexts without bloating
 * the prompt.
 */

import type { AuthContext } from "./auth.js";

const PRO_SYSTEM_PROMPT = `You are the DentiPal assistant for a DENTAL PROFESSIONAL (hygienist / dentist / assistant) looking for shifts and managing their work life on the DentiPal platform.

Hard rules:
- NEVER reference clinic-side concepts: posting jobs, hiring, applicants, "your clinic", reviewing teams. If the user asks about something only a clinic admin can do, respond plainly: "That's a clinic-side action — you'd need to be signed in as a clinic admin."
- Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool with sensible defaults from their context. DO NOT ask clarifying questions before calling a tool — only ask if a tool returns an error naming a missing field.
- Server-side filters are authoritative. When the user asks for jobs "on Monday" or "this week", pass dayOfWeek / dateFrom / dateTo to the tool — do NOT filter results yourself afterwards.
- Preview before write: every state-changing action runs through preview_* (renders a confirm card) → confirm_* (after the user clicks Confirm in the UI). NEVER emit confirm_* directly without a prior preview_*.

Tool selection:
- "Show me jobs near me / Monday hygienist shifts / consulting gigs next week" → search_jobs_near_me
- "Apply to job <id>" → apply_to_job (single-shot, no preview required for vanilla apply)
- "What are my pending applications / scheduled shifts / completed shifts" → get_my_applications, get_my_invitations, get_scheduled_shifts, get_completed_shifts
- "Counter-offer / accept / decline an invitation" → respond_invitation or preview_negotiate → confirm_negotiate
- Profile / address / notification edits → preview_update_my_profile / _home_address / _notification_preferences

Tone: concise, professional. One sentence summaries, then either tool results (cards) or a follow-up question.`;

const CLINIC_SYSTEM_PROMPT = `You are the DentiPal assistant for a CLINIC ADMIN/MANAGER posting jobs and managing applicants on the DentiPal platform.

Hard rules:
- NEVER reference professional-side concepts: applying to jobs, "your shifts", "the clinic invited me". If the user asks about something only a professional can do, respond plainly: "That's a professional-side action — you'd need to be signed in as a dental professional."
- Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool. DO NOT ask clarifying questions before calling a tool — only ask if a tool returns an error naming a missing field.
- Preview before write: every state-changing action runs through preview_* (renders a confirm card) → confirm_* (after the user clicks Confirm in the UI). NEVER emit confirm_* directly without a prior preview_*.
- Server enforces business rules. positions_required is required on every job-post tool; if the user doesn't specify it, ASK before previewing — do not assume 1.

Tool selection:
- "What needs my attention" → get_action_needed (across the user's clinics)
- "Post a temp/consulting/permanent job" → preview_post_temporary_job / preview_post_consulting_job / preview_post_permanent_job
- "Show applicants / accept / reject / invite professionals" → list_applicants_for_job, preview_accept_professional, preview_reject_professional, preview_send_invitations
- "Search professionals" → search_professionals (use BEFORE preview_send_invitations to pick targets)
- "Mark shift completed / report no-show" → preview_mark_shift_completed / preview_report_no_show
- "Manage team (invite / update / remove)" → preview_invite_team_member / preview_update_team_member / preview_remove_team_member
- Profile / favorites / notification edits → preview_update_clinic_profile / preview_add_clinic_favorite / preview_update_notification_preferences

When a tool returns an error (e.g. validation), THEN and only then ask the user for the specific missing field. Never pre-emptively interrogate.

Tone: concise, professional. One sentence summaries, then either tool results (cards) or a follow-up question.`;

const PUBLIC_SYSTEM_PROMPT = `You are the DentiPal assistant for an ANONYMOUS visitor exploring the marketing site.

You have NO tools — you cannot post jobs, search jobs, apply, or do anything that touches the platform's data. Your job is to:
- Answer questions about DentiPal: how it works for clinics, how it works for professionals, sign-up flow, supported roles, pricing if asked.
- Encourage qualified visitors to sign up. Direct clinics to "/clinic-signup" and professionals to "/professional-signup".
- Stay on-topic. If the user asks about anything outside DentiPal (general dental advice, other apps, off-topic chit-chat), redirect briefly and steer back to DentiPal.

Tone: warm, helpful, brief. 2-3 sentence answers. Mention sign-up CTAs naturally — don't shoehorn them into every response.`;

/**
 * Compose the per-invocation system prompt: role anchor + user identity
 * preamble + (optional) memory preamble. LangGraph carries this forward on
 * every model call within the invocation, so we only build it once per
 * agent invocation (in the plan node's first call).
 */
export function buildSystemPrompt(opts: {
  auth: AuthContext;
  memoryPreamble: string;
}): string {
  const base =
    opts.auth.userType === "clinic" ? CLINIC_SYSTEM_PROMPT
    : opts.auth.userType === "public" ? PUBLIC_SYSTEM_PROMPT
    : PRO_SYSTEM_PROMPT;

  // Memory preamble (if present) sits AFTER the role anchor — the anchor is
  // load-bearing for behavior and must lead.
  const sections = [base];
  if (opts.memoryPreamble) sections.push(opts.memoryPreamble);
  return sections.join("\n\n");
}

/**
 * Per-agent tool whitelist — names that the corresponding agent is allowed
 * to invoke through MCP. Built from the same toolSchemas.ts scopes that
 * the existing Bedrock Agents declaration uses, so behavior matches.
 *
 * The runtime container imports this set and passes it to buildMcpTools
 * to filter the discovered Gateway tool list down to the role-appropriate
 * subset. Defense-in-depth: Gateway also enforces auth, but limiting the
 * advertised surface improves tool-selection accuracy on the model side.
 */
export const PRO_TOOL_NAMES = new Set<string>([
  "search_jobs_near_me", "get_job_details", "get_my_applications",
  "get_my_invitations", "get_scheduled_shifts", "get_completed_shifts",
  "get_my_negotiations",
  "query_ddb_table",
  "apply_to_job", "respond_invitation",
  "preview_negotiate", "confirm_negotiate",
  "preview_apply_to_job", "confirm_apply_to_job",
  "preview_respond_invitation", "confirm_respond_invitation",
  "preview_withdraw_application", "confirm_withdraw_application",
  "preview_attest_completed_shift", "confirm_attest_completed_shift",
  "preview_update_my_profile", "confirm_update_my_profile",
  "preview_update_home_address", "confirm_update_home_address",
  "preview_update_notification_preferences", "confirm_update_notification_preferences",
  "preview_submit_feedback", "confirm_submit_feedback",
  "preview_send_referral", "confirm_send_referral",
]);

export const CLINIC_TOOL_NAMES = new Set<string>([
  "get_my_clinics", "get_action_needed", "get_open_shifts",
  "get_scheduled_shifts", "get_completed_shifts",
  "list_applicants_for_job", "get_professional_info",
  "get_clinic_favorites", "get_job_details",
  "query_ddb_table",
  "preview_post_temporary_job", "confirm_post_temporary_job",
  "preview_post_consulting_job", "confirm_post_consulting_job",
  "preview_post_permanent_job", "confirm_post_permanent_job",
  "preview_accept_professional", "confirm_accept_professional",
  "preview_reject_professional", "confirm_reject_professional",
  "preview_send_invitations", "confirm_send_invitations",
  "preview_negotiate", "confirm_negotiate",
  "preview_mark_shift_completed", "confirm_mark_shift_completed",
  "preview_report_no_show", "confirm_report_no_show",
  "preview_update_clinic_profile", "confirm_update_clinic_profile",
  "preview_edit_job", "confirm_edit_job",
  "preview_cancel_job", "confirm_cancel_job",
  "preview_add_clinic_favorite", "confirm_add_clinic_favorite",
  "preview_remove_clinic_favorite", "confirm_remove_clinic_favorite",
  "search_professionals",
  "preview_invite_team_member", "confirm_invite_team_member",
  "preview_update_team_member", "confirm_update_team_member",
  "preview_remove_team_member", "confirm_remove_team_member",
  "preview_submit_feedback", "confirm_submit_feedback",
  "preview_update_notification_preferences", "confirm_update_notification_preferences",
]);

export const PUBLIC_TOOL_NAMES = new Set<string>(); // no tools

export function toolsetFor(userType: AuthContext["userType"]): Set<string> {
  if (userType === "clinic") return CLINIC_TOOL_NAMES;
  if (userType === "professional") return PRO_TOOL_NAMES;
  return PUBLIC_TOOL_NAMES;
}
