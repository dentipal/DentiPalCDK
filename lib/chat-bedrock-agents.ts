/**
 * ChatBedrockAgents construct — declares 3 Bedrock Agents (Professional /
 * Clinic / Public) with their action groups auto-generated from the existing
 * tool catalog in `lambda/src/handlers/chat/toolSchemas.ts`.
 *
 * Architecture role: This is the MANAGED agent loop layer in the hybrid
 *   browser → WS → chatMessage Lambda
 *                → AgentCore Runtime container (orchestrator only)
 *                → Bedrock Agents (here — owns planning, LLM, tool dispatch)
 *                → dispatcher Lambda → existing 50 Lambda handlers
 *
 *   See the comprehensive plan at .claude/plans/give-me-a-comprehensive-dapper-wren.md
 *
 * Why we auto-generate action groups instead of writing OpenAPI specs:
 *   - The 50 chat tools already have JSONSchema input shapes in toolSchemas.ts
 *   - Bedrock Agents' FunctionSchema accepts the same shape (with caveats —
 *     no nested objects; type=string|number|integer|boolean|array only)
 *   - Maintaining two parallel catalogs would drift instantly
 *
 * Per-tool transformation:
 *   - Top-level `properties.<param>` → FunctionSchema Parameter with
 *     Type derived from inputSchema's `type`. Objects/complex shapes get
 *     Type:"string" with a note in Description so the model serializes JSON.
 *   - `inputSchema.required` array → per-parameter Required:true.
 *
 * Per-agent grouping:
 *   - Tools are filtered by the PRO_TOOL_NAMES / CLINIC_TOOL_NAMES sets
 *     from runtime/shared/roleAnchor.ts (same as today's runtime container).
 *   - Then bucketed by `tool.bucket` (info / search / response / audit)
 *     into separate AgentActionGroups — keeps each action group < 50
 *     functions and gives the model a clean mental model.
 *   - Public agent gets NO action groups (no tools — info-only).
 *
 * Memory: SESSION_SUMMARY is enabled on each agent. AWS auto-summarizes a
 *   session when it goes idle and re-injects the summary on the next turn
 *   that reuses the same sessionId. We also do our own episodic memory via
 *   AgentCore Memory in the runtime container — belt-and-suspenders so
 *   long-gap "what did I ask yesterday?" works regardless of which path
 *   survived.
 */

import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import {
  ALL_TOOLS,
  type ToolDefinition,
  type ToolBucket,
} from "../lambda/src/handlers/chat/toolSchemas";

// Per-agent tool whitelists. Duplicated from runtime/shared/roleAnchor.ts
// because that file is ESM (NodeNext) and the CDK app is CommonJS — direct
// cross-import fails. If you add a tool, update BOTH lists (the runtime
// container also needs to know which tools its role can call).
const PRO_TOOL_NAMES = new Set<string>([
  "search_jobs_near_me", "get_job_details", "get_my_applications",
  "get_my_invitations", "get_scheduled_shifts", "get_completed_shifts",
  "get_my_negotiations",
  "query_ddb_table",
  "apply_to_job", "respond_invitation",
  "preview_negotiate", "confirm_negotiate",
  // preview_apply_to_job / confirm_apply_to_job intentionally REMOVED.
  // When both apply paths were exposed, the agent inconsistently picked
  // the preview pair and asked the user for proposedRate/availability/
  // message even though apply_to_job is a single-shot zero-question tool.
  // For custom-rate applies the agent should use preview_negotiate AFTER
  // applying, not block the apply flow itself.
  "preview_respond_invitation", "confirm_respond_invitation",
  "preview_withdraw_application", "confirm_withdraw_application",
  "preview_attest_completed_shift", "confirm_attest_completed_shift",
  "preview_update_my_profile", "confirm_update_my_profile",
  "preview_update_home_address", "confirm_update_home_address",
  "preview_update_notification_preferences", "confirm_update_notification_preferences",
  "preview_submit_feedback", "confirm_submit_feedback",
  "preview_send_referral", "confirm_send_referral",
]);

const CLINIC_TOOL_NAMES = new Set<string>([
  "get_my_clinics", "get_my_posted_jobs", "get_action_needed", "get_open_shifts",
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

// ────────────────────────────────────────────────────────────────────────
// System prompts — kept in sync with runtime/shared/roleAnchor.ts. The
// runtime container reads roleAnchor.ts for the same content; if you edit
// one, edit both. (Importing directly from runtime/ here is intentional
// for the PRO/CLINIC/PUBLIC tool-name sets; system prompt text is local
// so the CDK file doesn't depend on a runtime build artifact.)
// ────────────────────────────────────────────────────────────────────────
// Instruction strings use plain ASCII (no em-dashes / arrows) because some
// AWS service-side validators reject non-ASCII characters in textual fields.
// Same constraint hit us on the IAM role description earlier in this project.
const PRO_INSTRUCTION = `You are the DentiPal assistant for a DENTAL PROFESSIONAL (hygienist / dentist / assistant) looking for shifts and managing their work life on the DentiPal platform.

Hard rules:
- NEVER reference clinic-side concepts: posting jobs, hiring, applicants, "your clinic", reviewing teams. If the user asks about something only a clinic admin can do, respond plainly: "That's a clinic-side action -- you'd need to be signed in as a clinic admin."
- Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool with sensible defaults from their context. DO NOT ask clarifying questions before calling a tool -- only ask if a tool returns an error naming a missing field.
- Server-side filters are authoritative. When the user asks for jobs "on Monday" or "this week", pass dayOfWeek / dateFrom / dateTo to the tool -- do NOT filter results yourself afterwards.
- Preview before write: every state-changing action runs through preview_* (renders a confirm card) -> confirm_* (after the user clicks Confirm in the UI). NEVER emit confirm_* directly without a prior preview_*.

Tool selection:
- "Show me jobs near me / Monday hygienist shifts / consulting gigs next week" -> search_jobs_near_me
- "Apply to job <id>" -> apply_to_job (single-shot, no preview required for vanilla apply)
- "What are my pending applications / scheduled shifts / completed shifts" -> get_my_applications, get_my_invitations, get_scheduled_shifts, get_completed_shifts
- "Counter-offer / accept / decline an invitation" -> respond_invitation or preview_negotiate -> confirm_negotiate
- Profile / address / notification edits -> preview_update_my_profile / _home_address / _notification_preferences

Tool errors:
- If a tool returns ok:false / an error message, REPORT IT to the user verbatim. NEVER fabricate a success message. NEVER say "successfully posted" / "successfully applied" / "successfully updated" if the tool errored. If preview succeeded but confirm errored, the action was NOT completed -- say "the post failed" or "the action couldn't be completed" and quote the underlying error verbatim.

Tone: concise, professional. One sentence summaries, then either tool results (cards) or a follow-up question.`;

const CLINIC_INSTRUCTION = `You are the DentiPal assistant for a CLINIC ADMIN/MANAGER posting jobs and managing applicants on the DentiPal platform.

Hard rules:
- NEVER reference professional-side concepts: applying to jobs, "your shifts", "the clinic invited me". If the user asks about something only a professional can do, respond plainly: "That's a professional-side action -- you'd need to be signed in as a dental professional."
- Be action-first: when the user expresses intent, IMMEDIATELY call the matching tool. DO NOT ask clarifying questions before calling a tool -- only ask if a tool returns an error naming a missing field.
- Preview before write: every state-changing action runs through preview_* (renders a confirm card) -> confirm_* (after the user clicks Confirm in the UI). NEVER emit confirm_* directly without a prior preview_*.
- Server enforces business rules. positions_required is required on every job-post tool; if the user doesn't specify it, ASK before previewing -- do not assume 1.

Tool selection:
- "Show my clinics / which clinics do I manage" -> get_my_clinics
- "My posted jobs / available jobs / list my postings / what jobs have I posted" -> get_my_posted_jobs (returns ALL jobs across ALL the user's clinics in one call; ALWAYS prefer this over chaining get_my_clinics then get_open_shifts per clinic)
- "Open shifts for clinic X / unfilled shifts at <clinic>" -> get_open_shifts (single clinicId)
- "What needs my attention" -> get_action_needed (per clinic)
- "Recent applicants / who applied to my jobs / show applicants" -> list_applicants_for_job. MANDATORY: when the user asks for applicants, you MUST call list_applicants_for_job (it returns the grouped-by-job applicants the UI knows how to render with Accept / Decline / Negotiate buttons). NEVER enumerate applicants by calling get_professional_info repeatedly -- that is a single-profile lookup, not a list, and produces blank profile cards.
- "View / profile of professional <name or userSub>" -> get_professional_info (ONE call for ONE professional only)
- "Post a temp/consulting/permanent job" -> preview_post_temporary_job / preview_post_consulting_job / preview_post_permanent_job
- "Accept / reject / invite professionals" -> preview_accept_professional / preview_reject_professional / preview_send_invitations
- "Cancel / delete / deactivate job posting" -> preview_cancel_job -> confirm_cancel_job
- "Edit job posting (rate, hours, positions, etc.)" -> preview_edit_job -> confirm_edit_job
- "Search professionals" -> search_professionals (use BEFORE preview_send_invitations to pick targets)
- "Mark shift completed / report no-show" -> preview_mark_shift_completed / preview_report_no_show
- "Manage team (invite / update / remove)" -> preview_invite_team_member / preview_update_team_member / preview_remove_team_member
- Profile / favorites / notification edits -> preview_update_clinic_profile / preview_add_clinic_favorite / preview_update_notification_preferences

Single-clinic affinity: when the user has previously named or clicked a single clinic ("I want to work with clinic X (clinicId=...)"), remember that clinicId for the rest of the turn and pass it implicitly to per-clinic tools (get_open_shifts, get_action_needed, list_applicants_for_job, search_professionals). Do NOT re-ask which clinic.

NEVER enumerate clinics during a post-job flow. When the user says "Post a temporary/consulting/permanent shift" or similar:
1. Do NOT call get_my_clinics first.
2. If the user has only one clinic (cached in session context), use it implicitly.
3. If the user has multiple clinics and hasn't named one in this turn, ASK in one sentence: "Which clinic should this be posted to?" -- do NOT dump the full clinics list as cards. The clinics list visually competes with the post flow and slows the user down.

The same rule applies to all per-clinic action flows (send invitations, edit a job, etc.): ask the missing clinicId via short text, never via a clinics list card.

When a tool returns an error (e.g. validation), THEN and only then ask the user for the specific missing field. Never pre-emptively interrogate.

Tool errors:
- If a tool returns ok:false / an error message, REPORT IT to the user verbatim. NEVER fabricate a success message. NEVER say "successfully posted" / "successfully sent" / "successfully accepted" if the tool errored. If preview succeeded but confirm errored, the action was NOT completed -- say "the post failed" or "the action couldn't be completed" and quote the underlying error verbatim so the user can correct course.

Tone: concise, professional. One sentence summaries, then either tool results (cards) or a follow-up question.`;

const PUBLIC_INSTRUCTION = `You are the DentiPal assistant for an ANONYMOUS visitor exploring the marketing site.

You have NO tools -- you cannot post jobs, search jobs, apply, or do anything that touches the platform's data. Your job is to:
- Answer questions about DentiPal: how it works for clinics, how it works for professionals, sign-up flow, supported roles, pricing if asked.
- Encourage qualified visitors to sign up. Direct clinics to "/clinic-signup" and professionals to "/professional-signup".
- Stay on-topic. If the user asks about anything outside DentiPal (general dental advice, other apps, off-topic chit-chat), redirect briefly and steer back to DentiPal.

Tone: warm, helpful, brief. 2-3 sentence answers. Mention sign-up CTAs naturally -- don't shoehorn them into every response.`;

export interface ChatBedrockAgentsProps {
  /** Lambda that handles tool calls. The same wrapperDispatch.ts Lambda
   *  we use for the AgentCore Gateway path — it'll grow a Bedrock-envelope
   *  branch in Deploy 2 of the plan. */
  dispatcherLambda: lambda.IFunction;

  /** Foundation model or inference profile ID. We use the cross-region
   *  Claude Haiku 4.5 inference profile that the rest of the stack uses. */
  foundationModel?: string;

  /** SESSION_SUMMARY storage window. AWS-managed summary is regenerated
   *  on session end and re-injected on the next turn that reuses the same
   *  sessionId. 30 days is the AWS default and matches our memory retention. */
  memoryStorageDays?: number;
}

export class ChatBedrockAgents extends Construct {
  readonly professionalAgentId: string;
  readonly clinicAgentId: string;
  readonly publicAgentId: string;
  readonly professionalAgentAliasId: string;
  readonly clinicAgentAliasId: string;
  readonly publicAgentAliasId: string;
  readonly professionalAgentArn: string;
  readonly clinicAgentArn: string;
  readonly publicAgentArn: string;

  constructor(scope: Construct, id: string, props: ChatBedrockAgentsProps) {
    super(scope, id);

    const region = cdk.Stack.of(this).region;
    const account = cdk.Stack.of(this).account;
    const foundationModel =
      props.foundationModel ??
      `arn:aws:bedrock:${region}:${account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`;
    const memoryStorageDays = props.memoryStorageDays ?? 30;

    // ────────────────────────────────────────────────────────────────
    // Shared agent execution role - Bedrock Agents service assumes this
    // when running the agent loop. Permissions: invoke the foundation
    // model and call the dispatcher Lambda (action group target).
    //
    // Inlined policies (not addToPolicy) because Bedrock validates the
    // role's permissions DURING CfnAgent creation. addToPolicy creates a
    // separate DefaultPolicy resource that attaches asynchronously, and
    // CFN was racing it -- agents started before the policy landed and
    // got "AccessDenied" on the IAM check. Inline policies attach as
    // part of the role's own CreateRole call, so they're guaranteed
    // present the moment the role exists.
    // ────────────────────────────────────────────────────────────────
    const agentRole = new iam.Role(this, "AgentExecutionRole", {
      assumedBy: new iam.ServicePrincipal("bedrock.amazonaws.com", {
        conditions: {
          StringEquals: { "aws:SourceAccount": account },
          ArnLike: {
            "aws:SourceArn": `arn:aws:bedrock:${region}:${account}:agent/*`,
          },
        },
      }),
      description:
        "Bedrock Agents execution role for DentiPal chat agents (pro/clinic/public)",
      inlinePolicies: {
        InvokeFoundationModel: new iam.PolicyDocument({
          statements: [
            // Explicit ARNs (no wildcards) for the SPECIFIC inference profile
            // and its three underlying foundation models. Bedrock Agents'
            // create-time validator simulates the role against the exact
            // resource ARN it'll use; wildcards like `inference-profile/us.anthropic.*`
            // sometimes fail the simulation even though they'd allow the call
            // at runtime. Plus GetInferenceProfile so the validator can
            // resolve the profile's underlying models.
            new iam.PolicyStatement({
              actions: [
                "bedrock:InvokeModel",
                "bedrock:InvokeModelWithResponseStream",
                "bedrock:GetInferenceProfile",
              ],
              resources: [
                `arn:aws:bedrock:us-east-1:${account}:inference-profile/us.anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-east-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
                `arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0`,
              ],
            }),
          ],
        }),
        InvokeDispatcher: new iam.PolicyDocument({
          statements: [
            new iam.PolicyStatement({
              actions: ["lambda:InvokeFunction"],
              resources: [
                props.dispatcherLambda.functionArn,
                `${props.dispatcherLambda.functionArn}:*`,
              ],
            }),
          ],
        }),
      },
    });

    // Bedrock Agents invokes the dispatcher Lambda via the
    // bedrock.amazonaws.com service principal (NOT through the agent
    // role). The Lambda needs a resource policy granting that.
    props.dispatcherLambda.addPermission("InvokeFromBedrockAgents", {
      principal: new iam.ServicePrincipal("bedrock.amazonaws.com"),
      action: "lambda:InvokeFunction",
      sourceAccount: account,
      sourceArn: `arn:aws:bedrock:${region}:${account}:agent/*`,
    });

    // ────────────────────────────────────────────────────────────────
    // Build action groups per agent. Tools are filtered by the
    // per-role allowlist, then bucketed (info / search / response /
    // audit). Public has no tools, so no action groups.
    // ────────────────────────────────────────────────────────────────
    const proActionGroups = buildActionGroupsForAgent(
      ALL_TOOLS.filter((t) => PRO_TOOL_NAMES.has(t.name)),
      props.dispatcherLambda.functionArn,
    );
    const clinicActionGroups = buildActionGroupsForAgent(
      ALL_TOOLS.filter((t) => CLINIC_TOOL_NAMES.has(t.name)),
      props.dispatcherLambda.functionArn,
    );

    // ────────────────────────────────────────────────────────────────
    // 3 CfnAgent resources. AutoPrepare:true makes the agent immediately
    // callable via the DRAFT version after deploy — no extra "prepare"
    // API call required.
    // ────────────────────────────────────────────────────────────────
    // CfnResource passes property keys verbatim to CloudFormation, and the
    // AWS::Bedrock::Agent schema uses PascalCase. The CDK L1 doesn't auto-
    // capitalize for us (unlike higher-level L2 constructs), so every key
    // here is written exactly as CFN expects.
    const sharedAgentProps = {
      AgentResourceRoleArn: agentRole.roleArn,
      FoundationModel: foundationModel,
      AutoPrepare: true,
      IdleSessionTTLInSeconds: 1800, // 30 min - when session goes idle, AWS auto-summarizes
      MemoryConfiguration: {
        EnabledMemoryTypes: ["SESSION_SUMMARY"],
        StorageDays: memoryStorageDays,
      },
    };

    const proAgent = new cdk.CfnResource(this, "ProfessionalAgent", {
      type: "AWS::Bedrock::Agent",
      properties: {
        AgentName: "DentiPal-ProfessionalAgent",
        Description:
          "DentiPal chatbot for dental professionals - shifts, applications, invitations, profile.",
        Instruction: PRO_INSTRUCTION,
        ActionGroups: proActionGroups,
        ...sharedAgentProps,
      },
    });

    const clinicAgent = new cdk.CfnResource(this, "ClinicAgent", {
      type: "AWS::Bedrock::Agent",
      properties: {
        AgentName: "DentiPal-ClinicAgent",
        Description:
          "DentiPal chatbot for clinic admins - job posting, applicants, team, profile.",
        Instruction: CLINIC_INSTRUCTION,
        ActionGroups: clinicActionGroups,
        ...sharedAgentProps,
      },
    });

    const publicAgent = new cdk.CfnResource(this, "PublicAgent", {
      type: "AWS::Bedrock::Agent",
      properties: {
        AgentName: "DentiPal-PublicAgent",
        Description:
          "DentiPal chatbot for anonymous marketing-site visitors - info only, no tools.",
        Instruction: PUBLIC_INSTRUCTION,
        ...sharedAgentProps,
      },
    });

    this.professionalAgentId = proAgent.getAtt("AgentId").toString();
    this.clinicAgentId = clinicAgent.getAtt("AgentId").toString();
    this.publicAgentId = publicAgent.getAtt("AgentId").toString();
    this.professionalAgentArn = proAgent.getAtt("AgentArn").toString();
    this.clinicAgentArn = clinicAgent.getAtt("AgentArn").toString();
    this.publicAgentArn = publicAgent.getAtt("AgentArn").toString();

    // ────────────────────────────────────────────────────────────────
    // Each agent gets a stable alias the runtime container invokes.
    // Without an explicit AgentAliasName the agent only exposes the
    // DRAFT version — fine for dev but we want a named alias so the
    // runtime env var can pin to a specific version slot.
    // ────────────────────────────────────────────────────────────────
    const proAlias = new cdk.CfnResource(this, "ProfessionalAgentAlias", {
      type: "AWS::Bedrock::AgentAlias",
      properties: {
        AgentAliasName: "live",
        AgentId: this.professionalAgentId,
        Description: "Live alias for the Professional agent - invoked by runtime container.",
      },
    });
    const clinicAlias = new cdk.CfnResource(this, "ClinicAgentAlias", {
      type: "AWS::Bedrock::AgentAlias",
      properties: {
        AgentAliasName: "live",
        AgentId: this.clinicAgentId,
        Description: "Live alias for the Clinic agent - invoked by runtime container.",
      },
    });
    const publicAlias = new cdk.CfnResource(this, "PublicAgentAlias", {
      type: "AWS::Bedrock::AgentAlias",
      properties: {
        AgentAliasName: "live",
        AgentId: this.publicAgentId,
        Description: "Live alias for the Public agent - invoked by runtime container.",
      },
    });
    this.professionalAgentAliasId = proAlias.getAtt("AgentAliasId").toString();
    this.clinicAgentAliasId = clinicAlias.getAtt("AgentAliasId").toString();
    this.publicAgentAliasId = publicAlias.getAtt("AgentAliasId").toString();
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/**
 * Group tools by bucket and emit one AgentActionGroup per bucket. Each
 * AgentActionGroup contains FunctionSchema.Functions[] — one entry per
 * tool in that bucket.
 *
 * Bucket names: info / search / response / audit. We use hyphenated
 * suffixed names ("info-tools" etc.) because AgentActionGroupName must
 * match `^([0-9a-zA-Z][_-]?){1,100}$` (alphanumeric + _/-).
 */
function buildActionGroupsForAgent(
  tools: ToolDefinition[],
  dispatcherLambdaArn: string,
): any[] {
  // Dedupe by tool name first. ALL_TOOLS concatenates the per-agent
  // registries, so tools with scope: "both" (get_scheduled_shifts,
  // get_completed_shifts, get_job_details, query_ddb_table, and the
  // shared Phase-4 pairs) appear twice. Bedrock Agents rejects
  // "Duplicate schema defined for function X" when an action group
  // gets two functions with the same name.
  const byName = new Map<string, ToolDefinition>();
  for (const t of tools) {
    if (!byName.has(t.name)) byName.set(t.name, t);
  }
  const buckets = new Map<ToolBucket, ToolDefinition[]>();
  for (const t of byName.values()) {
    const arr = buckets.get(t.bucket) ?? [];
    arr.push(t);
    buckets.set(t.bucket, arr);
  }
  const groups: any[] = [];
  for (const [bucket, toolsInBucket] of buckets) {
    // Skip empty buckets — Bedrock Agents rejects action groups with no functions.
    if (toolsInBucket.length === 0) continue;
    groups.push({
      ActionGroupName: `${bucket}-tools`,
      Description: bucketDescription(bucket),
      ActionGroupExecutor: { Lambda: dispatcherLambdaArn },
      FunctionSchema: {
        Functions: toolsInBucket.map(toFunctionDefinition),
      },
    });
  }
  return groups;
}

function bucketDescription(bucket: ToolBucket): string {
  switch (bucket) {
    case "info":
      return "Read-only lookups: details about a single record (job, professional, clinic).";
    case "search":
      return "Discovery queries that return lists (jobs near me, applicants for a job, my clinics).";
    case "response":
      return "Write actions. Always preview_* first then confirm_* after the user clicks Confirm in the UI.";
    case "audit":
      return "What did I do recently — historical lookups of the user's own activity.";
  }
}

/**
 * Convert one ToolDefinition into a Bedrock Agents FunctionSchema entry.
 *
 * Constraints from the CFN schema:
 *   - Function.Name pattern: ^([0-9a-zA-Z][_-]?){1,100}$ — our tool names
 *     are already snake_case so they fit.
 *   - Function.Description maxLength 1200.
 *   - Parameter.Type enum: string|number|integer|boolean|array — NO object.
 *     Nested objects in our JSONSchema get serialized as type:string with
 *     a Description hint telling the model "pass JSON string".
 *   - ParameterDetail.Description maxLength 500.
 *   - Parameter name pattern: ^([0-9a-zA-Z][_-]?){1,100}$.
 */
function toFunctionDefinition(tool: ToolDefinition): any {
  const inputProps = (tool.inputSchema?.properties as Record<string, any>) ?? {};
  const requiredFields: string[] = Array.isArray(tool.inputSchema?.required)
    ? tool.inputSchema.required
    : [];

  const parameters: Record<string, any> = {};
  for (const [paramName, rawSchema] of Object.entries(inputProps)) {
    const schema = (rawSchema || {}) as Record<string, any>;
    const isComplex =
      schema.type === "object" ||
      (schema.type === "array" && schema.items && schema.items.type === "object") ||
      Array.isArray(schema.oneOf) ||
      Array.isArray(schema.anyOf);
    const type = mapJsonSchemaTypeToBedrock(schema.type, isComplex);
    const userDescription: string | undefined = typeof schema.description === "string"
      ? schema.description
      : undefined;
    const description = isComplex
      ? `${userDescription ?? `JSON-stringified ${schema.type ?? "object"}`}. Pass as a JSON string.`
      : userDescription ?? `Parameter ${paramName} for ${tool.name}.`;

    parameters[paramName] = {
      Type: type,
      Description: truncate(description, 500),
      Required: requiredFields.includes(paramName),
    };
  }

  return {
    Name: tool.name,
    Description: truncate(tool.description, 1200),
    Parameters: parameters,
  };
}

function mapJsonSchemaTypeToBedrock(
  jsType: string | undefined,
  isComplex: boolean,
): "string" | "number" | "integer" | "boolean" | "array" {
  // Complex shapes (nested objects, arrays of objects, unions) → string
  // with a JSON-stringified payload. The model handles serialization;
  // the dispatcher Lambda's pre-normalizers parse it back to an object.
  if (isComplex) return "string";
  switch (jsType) {
    case "number":
      return "number";
    case "integer":
      return "integer";
    case "boolean":
      return "boolean";
    case "array":
      return "array";
    case "string":
    default:
      return "string";
  }
}

function truncate(s: string, max: number): string {
  if (!s) return "";
  return s.length > max ? s.slice(0, max - 3) + "..." : s;
}
