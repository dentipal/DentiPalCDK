/**
 * AgentCore Gateway → Lambda dispatcher.
 *
 * This Lambda is the single Gateway target for EVERY chat tool. Gateway
 * sends an MCP tool-invocation payload; we look the tool up in the catalog,
 * run pre-normalizers, dispatch to the right existing business handler in
 * process (via handlerAdapter — same path toolExecutor uses today), run
 * post-normalizers, and return the result.
 *
 * Why one dispatcher instead of N per-tool wrappers:
 *   - Single CDK declaration, ~50 Gateway targets all pointing here.
 *   - Shared normalizer logic stays in one process — no cold-start tax
 *     spread across 15+ tiny Lambdas.
 *   - Easier observability: one log group for the entire tool surface.
 *   - Easier to add cross-cutting concerns (rate limiting, audit logging,
 *     metric emission) — change one place.
 *
 * Trade-off: the dispatcher's IAM role unions every wrapped tool's DDB +
 * Cognito permissions. CDK grants are explicit so a single audit can see
 * exactly what this Lambda can touch.
 *
 * Preview / confirm semantics, identical to toolExecutor.genericPreview /
 * genericConfirm but reachable from Gateway too:
 *   - `preview_*` → run validation + pre-normalizers, write a PreviewGates
 *     row, return a confirm-card payload. NO underlying handler call.
 *   - `confirm_*` → verify the preview gate (PreviewGates table), pre-
 *     normalize, call handler, burn the gate row on success.
 */

import type { Context } from "aws-lambda";
// Routing metadata + MCP schema are unified in toolSchemas.ts now (a tool's
// `gateway` field carries handlerModule / method / inputShape / normalizers).
// Single source of truth — no separate catalog file to drift from.
import { getToolDefinition, GatewayRouting, GatewayNormalizer } from "../chat/toolSchemas";
import {
  normalizeClinicIdsInPlace,
  normalizeProfessionalRoleInPlace,
  normalizeDatesInPlace,
  normalizePayTypeInPlace,
  filterApplicationsByStatusInResult,
  filterShiftsByDayAndDateRange,
  filterApplicantsToActionableInResult,
  trimPastDatesFromPostings,
  ClinicResolverContext,
} from "./normalizers";
import { callHandlerInProcess } from "../chat/handlerAdapter";
import { putPreview } from "../chat/previewGateStore";
import {
  verifyPreviewBeforeConfirm,
  clearPreviewAfterConfirm,
} from "../chat/previewGate";
import { runQueryDdbTable, QueryDdbInput } from "../chat/ddbQueryTool";
import type { AuthContext } from "../utils";

// ─────────────────────────────────────────────────────────────────────────
// Gateway invocation envelope
// ─────────────────────────────────────────────────────────────────────────

/**
 * Shape of the event AgentCore Gateway sends to a Lambda target. This is
 * approximate — verify against the live AgentCore Gateway docs before deploy.
 * The salient fields:
 *   - `tool` (or `name`)        — the MCP tool name (matches catalog).
 *   - `arguments` (or `input`)  — the tool's input object per its schema.
 *   - `context.identity`        — authenticated caller info propagated from
 *                                 the Gateway's CUSTOM_JWT authorizer.
 *   - `context.session`         — runtime session metadata (sessionId,
 *                                 conversationId once WS-5 lands).
 *
 * We probe both naming conventions so a Gateway SDK rename doesn't silently
 * break us.
 */
interface GatewayInvocationEvent {
  tool?: string;
  name?: string;
  arguments?: Record<string, any>;
  input?: Record<string, any>;
  context?: {
    identity?: {
      userSub?: string;
      userGroups?: string[];
      userType?: string;
      email?: string;
      /** Cached clinics list — runtime agent forwards this from session
       *  state so clinic-name → UUID resolution works in normalizers. */
      clinics?: Array<{ clinicId: string; name?: string }>;
    };
    session?: {
      conversationId?: string;
      runtimeSessionId?: string;
    };
  };
}

interface DispatchOk { ok: true; data: any; }
interface DispatchErr { ok: false; status: number; error: string; }
type DispatchResult = DispatchOk | DispatchErr;

const ok = (data: any): DispatchOk => ({ ok: true, data });
const err = (status: number, error: string): DispatchErr => ({ ok: false, status, error });

// ─────────────────────────────────────────────────────────────────────────
// Normalizer dispatch
// ─────────────────────────────────────────────────────────────────────────

function runPreNormalizers(
  tags: GatewayNormalizer[] | undefined,
  input: Record<string, any>,
  clinicCtx: ClinicResolverContext | undefined,
): void {
  if (!tags?.length) return;
  for (const tag of tags) {
    switch (tag) {
      case "clinicIds":
        normalizeClinicIdsInPlace(input, clinicCtx);
        break;
      case "professionalRole":
        normalizeProfessionalRoleInPlace(input);
        break;
      case "dates":
        normalizeDatesInPlace(input);
        break;
      case "payTypeAlias":
        // Map "hourly" / "salary" / etc. to the handler's canonical pay_type
        // values BEFORE the gate stores the preview payload, so the diff
        // guard on confirm compares apples-to-apples.
        normalizePayTypeInPlace(input);
        break;
      // Pre-call slots reserved for the response-transform tags; safe no-ops here.
      case "applicationStatusFilter":
      case "dayDateRangeFilter":
      case "actionableApplicants":
      case "trimPastDates":
        break;
    }
  }
}

function runPostNormalizers(
  tags: GatewayNormalizer[] | undefined,
  result: { status: number; body: any },
  input: Record<string, any>,
): { status: number; body: any } {
  if (!tags?.length) return result;
  let r = result;
  for (const tag of tags) {
    switch (tag) {
      case "applicationStatusFilter": {
        // Translate the chat-side bucket name into the underlying status
        // alphabet. Matches the buckets toolExecutor knows about so chat
        // and dashboard tabs stay aligned.
        const STATUS_BUCKETS: Record<string, string[]> = {
          pending: ["pending", "negotiating"],
          scheduled: ["scheduled", "accepted", "hired", "confirmed"],
          completed: ["completed"],
          no_show: ["no_show", "no-show"],
          rejected: ["rejected", "declined", "canceled"],
        };
        const statusInput = (input.status || "").toString().toLowerCase().trim();
        const allowed = STATUS_BUCKETS[statusInput];
        if (allowed) r = filterApplicationsByStatusInResult(r, allowed);
        break;
      }
      case "dayDateRangeFilter":
        r = filterShiftsByDayAndDateRange(r, {
          dayOfWeek: input.dayOfWeek,
          dateFrom: input.dateFrom,
          dateTo: input.dateTo,
        });
        break;
      case "actionableApplicants":
        r = filterApplicantsToActionableInResult(r);
        break;
      case "trimPastDates": {
        // Trim past dates from whichever array shape the handler returned.
        // getClinicShifts returns `{ message, data: [...] }` (array DIRECTLY
        // under `data`), not `{shifts:[...]}` — the original whitelist missed
        // that and past-dated shifts leaked through.
        const dataIsArray = Array.isArray(r.body?.data);
        const postings = r.body?.jobs || r.body?.jobPostings || r.body?.shifts || (dataIsArray ? r.body.data : null);
        if (Array.isArray(postings)) {
          const trimmed = trimPastDatesFromPostings(postings);
          const next = { ...r.body };
          if (r.body?.jobs) next.jobs = trimmed;
          else if (r.body?.jobPostings) next.jobPostings = trimmed;
          else if (r.body?.shifts) next.shifts = trimmed;
          else if (dataIsArray) next.data = trimmed;
          if (typeof next.totalCount === "number") next.totalCount = trimmed.length;
          r = { status: r.status, body: next };
        }
        break;
      }
      // No-ops on the response side.
      case "clinicIds":
      case "professionalRole":
      case "dates":
      case "payTypeAlias":
        break;
    }
  }
  return r;
}

// ─────────────────────────────────────────────────────────────────────────
// Underlying handler call
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lazy module map keyed by the catalog's handlerModule string. Each Gateway
 * cold start loads only the modules its handful of invocations touch — full
 * eager imports would balloon init time across the ~30 referenced handlers.
 *
 * Adding a new handler: extend this switch. Build-time check is the catalog
 * lookup at `lookupTool(...)` — if the dispatcher doesn't recognize a
 * module name it returns 501 (intentional — surfaces missing wiring loudly).
 */
async function invokeUnderlyingHandler(
  module: string,
  args: { method: any; pathParameters?: Record<string, string>; body?: any; queryStringParameters?: Record<string, string>; auth: AuthContext },
): Promise<{ status: number; body: any }> {
  switch (module) {
    case "getProfessionalFilteredJobs": {
      const { handler } = await import("../getProfessionalFilteredJobs");
      return callHandlerInProcess(handler, args);
    }
    case "getJobPosting": {
      const { handler } = await import("../getJobPosting");
      return callHandlerInProcess(handler, args);
    }
    case "getJobApplications": {
      const { handler } = await import("../getJobApplications");
      return callHandlerInProcess(handler, args);
    }
    case "getJobInvitations": {
      const { runGetJobInvitations } = await import("../getJobInvitations");
      const r = await runGetJobInvitations(args.auth);
      return { status: r.status, body: r.body };
    }
    case "getAllNegotiations-Prof": {
      const { handler } = await import("../getAllNegotiations-Prof");
      return callHandlerInProcess(handler, args);
    }
    case "getScheduledShifts": {
      const { handler } = await import("../getScheduledShifts");
      return callHandlerInProcess(handler, args);
    }
    case "getCompletedShifts": {
      const { handler } = await import("../getCompletedShifts");
      return callHandlerInProcess(handler, args);
    }
    case "getUsersClinics": {
      const { handler } = await import("../getUsersClinics");
      return callHandlerInProcess(handler, args);
    }
    case "getActionNeeded": {
      const { handler } = await import("../getActionNeeded");
      return callHandlerInProcess(handler, args);
    }
    case "getClinicShifts": {
      const { handler } = await import("../getClinicShifts");
      // The clinic-shifts handler is tab-switched via pathParameters.proxy.
      // Force "open-shifts" so get_open_shifts always hits that branch.
      const params = { ...(args.pathParameters || {}), proxy: "open-shifts" };
      return callHandlerInProcess(handler, { ...args, pathParameters: params });
    }
    case "getMyPostedJobs": {
      // Composed virtual handler — fans out get_my_clinics → get_open_shifts
      // per clinic, then merges into a single `{jobs:[...]}` payload the
      // ResultCards JobResultsList already knows how to render (with the
      // clinicSide flag flipped on by ToolResultBody).
      //
      // No new business Lambda — this stays in the chat-gateway layer so the
      // 50 existing handlers remain untouched. Each fan-out is in-process
      // (callHandlerInProcess) so latency is single-Lambda invocation cost,
      // not a per-clinic round-trip through API Gateway.
      const { handler: clinicsHandler } = await import("../getUsersClinics");
      const clinicsRes = await callHandlerInProcess(clinicsHandler, args);
      if (clinicsRes.status >= 400) return clinicsRes;
      const clinicList: Array<{ clinicId?: string; name?: string }> =
        (clinicsRes.body?.clinics || clinicsRes.body?.data?.clinics || []) as any[];
      if (!Array.isArray(clinicList) || clinicList.length === 0) {
        return { status: 200, body: { status: "success", jobs: [], totalClinics: 0, message: "No clinics under this user." } };
      }
      const { handler: shiftsHandler } = await import("../getClinicShifts");
      const allJobs: any[] = [];
      const perClinicErrors: Array<{ clinicId?: string; error: string }> = [];
      // Sequential to keep the dispatcher Lambda concurrency footprint
      // predictable; clinic counts per user are small (<20 in practice) so
      // serial is fine.
      for (const c of clinicList) {
        const clinicId = c.clinicId;
        if (!clinicId) continue;
        try {
          const params = { ...(args.pathParameters || {}), proxy: "open-shifts", clinicId };
          const r = await callHandlerInProcess(shiftsHandler, { ...args, pathParameters: params });
          if (r.status >= 400) {
            perClinicErrors.push({ clinicId, error: r.body?.error || `status ${r.status}` });
            continue;
          }
          const shifts = (r.body?.shifts || r.body?.data?.shifts || r.body?.jobs || []) as any[];
          for (const s of shifts) {
            allJobs.push({ ...s, clinicId, clinicName: c.name || s.clinicName });
          }
        } catch (e: any) {
          perClinicErrors.push({ clinicId, error: e?.message || String(e) });
        }
      }
      // Newest first so the most recently posted shows up at the top of the
      // sidebar cards. Falls back to clinicName for stable ordering when no
      // date field is present.
      allJobs.sort((a, b) => {
        const ad = a.createdAt || a.date || "";
        const bd = b.createdAt || b.date || "";
        return String(bd).localeCompare(String(ad));
      });
      return {
        status: 200,
        body: {
          status: "success",
          jobs: allJobs,
          totalJobs: allJobs.length,
          totalClinics: clinicList.length,
          errors: perClinicErrors.length ? perClinicErrors : undefined,
          message: `${allJobs.length} posted job(s) across ${clinicList.length} clinic(s).`,
        },
      };
    }
    case "getJobApplicantsOfAClinic": {
      const { handler } = await import("../getJobApplicantsOfAClinic");
      return callHandlerInProcess(handler, args);
    }
    case "getPublicProfessionalProfile": {
      const { handler } = await import("../getPublicProfessionalProfile");
      return callHandlerInProcess(handler, args);
    }
    case "getClinicFavorites": {
      const { handler } = await import("../getClinicFavorites");
      return callHandlerInProcess(handler, args);
    }
    case "getAllProfessionals": {
      const { handler } = await import("../getAllProfessionals");
      return callHandlerInProcess(handler, args);
    }
    case "createJobApplication": {
      const { handler } = await import("../createJobApplication");
      return callHandlerInProcess(handler, args);
    }
    case "respondToInvitation": {
      const { handler } = await import("../respondToInvitation");
      return callHandlerInProcess(handler, args);
    }
    case "respondToNegotiation": {
      const { handler } = await import("../respondToNegotiation");
      return callHandlerInProcess(handler, args);
    }
    case "deleteJobApplication": {
      const { handler } = await import("../deleteJobApplication");
      return callHandlerInProcess(handler, args);
    }
    case "updateCompletedShifts": {
      const { handler } = await import("../updateCompletedShifts");
      return callHandlerInProcess(handler, args);
    }
    case "updateProfessionalProfile": {
      const { handler } = await import("../updateProfessionalProfile");
      return callHandlerInProcess(handler, args);
    }
    case "updateUserAddress": {
      const { handler } = await import("../updateUserAddress");
      return callHandlerInProcess(handler, args);
    }
    case "updateNotificationPreferences": {
      const { handler } = await import("../updateNotificationPreferences");
      return callHandlerInProcess(handler, args);
    }
    case "submitFeedback": {
      const { handler } = await import("../submitFeedback");
      return callHandlerInProcess(handler, args);
    }
    case "sendReferralInvite": {
      const { handler } = await import("../sendReferralInvite");
      return callHandlerInProcess(handler, args);
    }
    case "createTemporaryJob": {
      const { handler } = await import("../createTemporaryJob");
      return callHandlerInProcess(handler, args);
    }
    case "createMultiDayConsulting": {
      const { handler } = await import("../createMultiDayConsulting");
      return callHandlerInProcess(handler, args);
    }
    case "createPermanentJob": {
      const { handler } = await import("../createPermanentJob");
      // Unified create handler — needs job_type in body.
      const body = { ...(args.body || {}), job_type: "permanent" };
      return callHandlerInProcess(handler, { ...args, body });
    }
    case "acceptProf": {
      const { handler } = await import("../acceptProf");
      return callHandlerInProcess(handler, args);
    }
    case "rejectProf": {
      const { handler } = await import("../rejectProf");
      return callHandlerInProcess(handler, args);
    }
    case "sendJobInvitations": {
      const { handler } = await import("../sendJobInvitations");
      return callHandlerInProcess(handler, args);
    }
    case "confirmShiftCompletion": {
      const { handler } = await import("../confirmShiftCompletion");
      return callHandlerInProcess(handler, args);
    }
    case "reportNoShow": {
      const { handler } = await import("../reportNoShow");
      return callHandlerInProcess(handler, args);
    }
    case "updateClinicProfile": {
      const { handler } = await import("../updateClinicProfile");
      return callHandlerInProcess(handler, args);
    }
    case "updateJobPosting": {
      const { handler } = await import("../updateJobPosting");
      return callHandlerInProcess(handler, args);
    }
    case "updateJobStatus": {
      const { handler } = await import("../updateJobStatus");
      // The catalog routes cancel_job here with a generic body; force the
      // inactive status so the underlying handler doesn't need a per-call
      // override.
      const body = { ...(args.body || {}), status: "inactive" };
      return callHandlerInProcess(handler, { ...args, body });
    }
    case "addClinicFavorite": {
      const { handler } = await import("../addClinicFavorite");
      return callHandlerInProcess(handler, args);
    }
    case "removeClinicFavorite": {
      const { handler } = await import("../removeClinicFavorite");
      return callHandlerInProcess(handler, args);
    }
    case "createAssignment": {
      const { handler } = await import("../createAssignment");
      return callHandlerInProcess(handler, args);
    }
    case "updateAssignment": {
      const { handler } = await import("../updateAssignment");
      return callHandlerInProcess(handler, args);
    }
    case "deleteAssignment": {
      const { handler } = await import("../deleteAssignment");
      return callHandlerInProcess(handler, args);
    }
    default:
      return { status: 501, body: { error: `Unmapped handlerModule '${module}'` } };
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Input shape → API-Gateway-style event params
// ─────────────────────────────────────────────────────────────────────────

function buildCallArgs(
  toolName: string,
  entry: GatewayRouting,
  input: Record<string, any>,
  auth: AuthContext,
): { method: any; pathParameters?: Record<string, string>; body?: any; queryStringParameters?: Record<string, string>; auth: AuthContext } {
  const base = { method: entry.method, auth };
  switch (entry.inputShape) {
    case "body":
      return { ...base, body: input };
    case "query": {
      // Coerce every value to string — query params are stringly-typed.
      const qs: Record<string, string> = {};
      for (const [k, v] of Object.entries(input)) {
        if (v === undefined || v === null) continue;
        qs[k] = String(v);
      }
      return { ...base, queryStringParameters: qs };
    }
    case "path": {
      const key = entry.pathParamKey || "id";
      const val = input[key];
      if (val === undefined) {
        throw new Error(`Tool '${toolName}' requires path param '${key}'`);
      }
      return { ...base, pathParameters: { [key]: String(val) } };
    }
    case "pathAndBody": {
      const key = entry.pathParamKey || "id";
      const val = input[key];
      if (val === undefined) {
        throw new Error(`Tool '${toolName}' requires path param '${key}'`);
      }
      const { [key]: _drop, ...body } = input;
      return { ...base, pathParameters: { [key]: String(val) }, body };
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────

/**
 * Lambda handler invoked by AgentCore Gateway. Returns the raw tool result
 * which Gateway forwards back to the calling runtime agent as an MCP
 * tool-result block.
 *
 * Errors: returned as `{ ok: false, status, error }` — the Gateway wrapper
 * on the runtime side translates these into MCP error frames. We do NOT
 * throw from this handler because Gateway treats an unhandled exception as
 * a 500 with no body, which the model sees as "Error (undefined)" — same
 * surfacing problem the old toolExecutor fixed with safeBodyToString.
 */
// ─────────────────────────────────────────────────────────────────────────
// Bedrock Agents envelope shape (action group invocation).
// Reference: https://docs.aws.amazon.com/bedrock/latest/userguide/agents-lambda.html
// Bedrock sends:
//   {
//     messageVersion: "1.0",
//     agent: { name, id, alias, version },
//     actionGroup: "info-tools",
//     function: "get_action_needed",
//     parameters: [{ name, type, value }, ...],
//     sessionId: "<conversationId>",
//     sessionAttributes: { ... },
//     promptSessionAttributes: { identity_userSub, identity_clinics_json, ... }
//   }
// We expect: a JSON response body the agent stringifies + a wrapped envelope:
//   {
//     messageVersion: "1.0",
//     response: {
//       actionGroup, function,
//       functionResponse: { responseBody: { TEXT: { body: "<json>" } } }
//     },
//     sessionAttributes, promptSessionAttributes  // echoed back
//   }
// ─────────────────────────────────────────────────────────────────────────
interface BedrockActionEvent {
  messageVersion: "1.0";
  agent?: { name?: string; id?: string; alias?: string; version?: string };
  actionGroup?: string;
  function?: string;
  parameters?: Array<{ name: string; type: string; value: any }>;
  sessionId?: string;
  sessionAttributes?: Record<string, string>;
  promptSessionAttributes?: Record<string, string>;
}

function isBedrockActionEvent(ev: any): ev is BedrockActionEvent {
  return ev && typeof ev === "object" && ev.messageVersion === "1.0" && typeof ev.function === "string";
}

/**
 * Convert a Bedrock action-group invocation into the existing
 * GatewayInvocationEvent shape so the rest of this dispatcher (preview/
 * confirm gates, normalizers, handler call) runs UNCHANGED.
 *
 * Parameters: Bedrock sends an array of {name, type, value}. We rebuild
 * the input object. For parameters whose CFN type was "string" but whose
 * underlying JSONSchema was object/array (we serialized as JSON strings
 * in chat-bedrock-agents.ts), the model would have produced a stringified
 * JSON; parse it back here. Catch parse errors silently — if the model
 * sent a plain string, just keep it.
 *
 * Identity: Bedrock Agents has no per-invocation context for caller IAM
 * identity. The runtime container (Deploy 3) passes userSub/email/clinics
 * via `promptSessionAttributes` as JSON-stringified values; we deserialize
 * them here. If they're missing (e.g. CLI sanity tests), we fall back to
 * placeholder values so the dispatcher doesn't 401.
 */
function bedrockToGatewayEvent(ev: BedrockActionEvent): GatewayInvocationEvent {
  const args: Record<string, any> = {};
  for (const p of ev.parameters ?? []) {
    let value: any = p.value;
    // Bedrock Agents serializes ALL parameter values as strings in the
    // event envelope, regardless of the schema type. Coerce based on the
    // type the FunctionSchema declared so downstream handlers (which
    // validate strictly — e.g. positions_required must be number 1..20)
    // don't reject "2" vs 2.
    if (typeof value === "string") {
      if (p.type === "integer" || p.type === "number") {
        const n = Number(value);
        if (!Number.isNaN(n)) value = p.type === "integer" ? Math.trunc(n) : n;
      } else if (p.type === "boolean") {
        const lc = value.toLowerCase().trim();
        if (lc === "true") value = true;
        else if (lc === "false") value = false;
      } else if (p.type === "string") {
        const trimmed = value.trim();
        if (
          (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
          (trimmed.startsWith("[") && trimmed.endsWith("]"))
        ) {
          try { value = JSON.parse(trimmed); } catch { /* keep as string */ }
        }
      } else if (p.type === "array") {
        const trimmed = value.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          try { value = JSON.parse(trimmed); } catch { /* keep as string */ }
        }
      }
    }
    args[p.name] = value;
  }

  const psa = ev.promptSessionAttributes ?? {};
  let clinics: Array<{ clinicId: string; name?: string }> = [];
  if (psa.identity_clinics_json) {
    try { clinics = JSON.parse(psa.identity_clinics_json); } catch { /* keep [] */ }
  }
  let userGroups: string[] = [];
  if (psa.identity_user_groups_json) {
    try { userGroups = JSON.parse(psa.identity_user_groups_json); } catch { /* keep [] */ }
  }

  return {
    tool: ev.function,
    arguments: args,
    context: {
      identity: {
        userSub: psa.identity_user_sub || "bedrock-agent-cli-test",
        userType: psa.identity_user_type || "clinic",
        userGroups,
        email: psa.identity_email || "",
        clinics,
      },
      session: { conversationId: ev.sessionId },
    },
  };
}

function wrapForBedrock(
  ev: BedrockActionEvent,
  result: DispatchResult,
): any {
  // Bedrock wants the tool output as a string. Stringify either the
  // success data or a structured error object so the model has enough
  // context to react (and our trace translator can extract it).
  const body = result.ok
    ? JSON.stringify({ ok: true, data: result.data })
    : JSON.stringify({ ok: false, status: result.status, error: result.error });
  return {
    messageVersion: "1.0",
    response: {
      actionGroup: ev.actionGroup,
      function: ev.function,
      functionResponse: {
        responseBody: { TEXT: { body } },
      },
    },
    sessionAttributes: ev.sessionAttributes ?? {},
    promptSessionAttributes: ev.promptSessionAttributes ?? {},
  };
}

/**
 * Lambda entry. Dispatches on envelope shape:
 *   - Bedrock Agents action-group invocation (messageVersion: "1.0") →
 *     translate envelope, run the same core dispatcher, wrap result in
 *     the Bedrock response shape.
 *   - Everything else: treat as the existing AgentCore Gateway MCP shape.
 *     During the hybrid migration both code paths exist; once Deploy 4
 *     removes the Gateway wiring this branch becomes the only one.
 */
export const handler = async (event: any, ctx: Context): Promise<any> => {
  if (isBedrockActionEvent(event)) {
    const translated = bedrockToGatewayEvent(event);
    const result = await runDispatcher(translated, ctx);
    return wrapForBedrock(event, result);
  }
  return runDispatcher(event as GatewayInvocationEvent, ctx);
};

const runDispatcher = async (event: GatewayInvocationEvent, _ctx: Context): Promise<DispatchResult> => {
  const toolName = event.tool || event.name;
  if (!toolName) return err(400, "Gateway event missing tool/name field");

  const def = getToolDefinition(toolName);
  if (!def) return err(400, `Unknown tool '${toolName}' (no schema entry)`);
  const entry = def.gateway;
  if (!entry) return err(501, `Tool '${toolName}' is not wired to Gateway (missing gateway routing in toolSchemas)`);

  const input = (event.arguments || event.input || {}) as Record<string, any>;

  const identity = event.context?.identity || {};
  if (!identity.userSub) return err(401, "Gateway event missing context.identity.userSub");
  const auth: AuthContext = {
    userSub: identity.userSub,
    userGroups: identity.userGroups || [],
    userType: identity.userType || "professional",
    email: identity.email || "",
  };
  const clinicCtx: ClinicResolverContext = { clinics: identity.clinics || [] };
  const conversationId = event.context?.session?.conversationId;

  console.log(`[gatewayDispatch] tool=${toolName} userSub=${auth.userSub} input=${JSON.stringify(input).slice(0, 300)}`);

  try {
    // ----- preview_* shortcut: write the gate row and return the card -----
    if (toolName.startsWith("preview_")) {
      runPreNormalizers(entry.preNormalizers, input, clinicCtx);
      const previewToken = await putPreview({
        userSub: auth.userSub,
        toolName,
        payload: input,
        conversationId,
      });
      return ok({
        kind: "confirm_card",
        action: toolName.replace(/^preview_/, ""),
        previewToken,
        fields: input,
        warnings: [],
        confirmTool: toolName.replace(/^preview_/, "confirm_"),
      });
    }

    // ----- confirm_* shortcut: normalize FIRST so the gate compares apples
    // to apples, then verify, then route to the handler.
    //
    // Why normalize before verify: preview_* normalizes the input (e.g.
    // "qwerty clinic" -> "<uuid>") and stores the normalized payload as the
    // gate. If confirm_* verifies the raw input first, the model's slight
    // wording variations (raw clinic name vs. UUID) trip the equality check
    // even though the underlying intent matches. Running normalizers on both
    // sides eliminates the drift.
    if (toolName.startsWith("confirm_")) {
      const { previewToken, ...payload } = input;
      runPreNormalizers(entry.preNormalizers, payload, clinicCtx);
      const gate = await verifyPreviewBeforeConfirm(auth.userSub, toolName, previewToken, payload);
      if (!gate.ok) return err(gate.status, gate.reason);
      const callArgs = buildCallArgs(toolName, entry, payload, auth);
      const r = await invokeUnderlyingHandler(entry.handlerModule, callArgs);
      if (r.status >= 400) {
        return err(r.status, typeof r.body === "string" ? r.body : JSON.stringify(r.body));
      }
      await clearPreviewAfterConfirm(auth.userSub, previewToken);
      return ok(r.body);
    }

    // ----- query_ddb_table escape hatch -----
    if (entry.handlerModule === "__ddbQuery__") {
      // The DDB query tool wants a ChatSession-like object for auth scoping
      // (it harvests known clinic/user IDs out of session.userContext).
      // Build a minimal shim — the runtime agent already populated clinics.
      const sessionShim = {
        userSub: auth.userSub,
        connectionId: "",
        agentType: (auth.userType || "professional") as any,
        bedrockSessionId: "",
        connectedAt: 0,
        lastActivityAt: 0,
        ttl: 0,
        userContext: {
          agentType: auth.userType,
          clinics: clinicCtx.clinics || [],
        } as any,
      };
      const r = await runQueryDdbTable(input as QueryDdbInput, auth, sessionShim);
      if (!r.ok) return err(r.status, r.error);
      return ok(r.data);
    }

    // ----- standard info / single-shot write path -----
    runPreNormalizers(entry.preNormalizers, input, clinicCtx);
    const callArgs = buildCallArgs(toolName, entry, input, auth);
    let r = await invokeUnderlyingHandler(entry.handlerModule, callArgs);
    r = runPostNormalizers(entry.postNormalizers, r, input);
    if (r.status >= 400) {
      return err(r.status, typeof r.body === "string" ? r.body : JSON.stringify(r.body));
    }
    return ok(r.body);
  } catch (e: any) {
    console.error(`[gatewayDispatch] tool=${toolName} threw`, e);
    return err(500, e?.message || "Dispatcher threw an unhandled exception");
  }
};
