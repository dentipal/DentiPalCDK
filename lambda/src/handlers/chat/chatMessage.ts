import { APIGatewayProxyResult } from "aws-lambda";
import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import { DynamoDBClient, QueryCommand } from "@aws-sdk/client-dynamodb";
import {
  CognitoIdentityProviderClient,
} from "@aws-sdk/client-cognito-identity-provider";
import {
  getSessionByConnectionId,
  refreshSession,
  createSessionForConnection,
  setUserContext,
  setUserGroupsAndAgentType,
  markContextInjected,
  AgentType,
  ChatSession,
} from "./sessionStore";
import { executeTool, ToolCall } from "./toolExecutor";
import { fetchUserContext, renderContextPreamble, UserContext } from "./userContext";
import { AuthContext, CLINIC_ROLES } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const CONNS_TABLE = process.env.CONNS_TABLE || "DentiPal-V5-Connections"; // existing user-to-user table
const USER_POOL_ID = process.env.USER_POOL_ID || "";

const PROFESSIONAL_AGENT_ID = process.env.BEDROCK_PROFESSIONAL_AGENT_ID || "";
const PROFESSIONAL_AGENT_ALIAS_ID = process.env.BEDROCK_PROFESSIONAL_AGENT_ALIAS_ID || "";
const CLINIC_AGENT_ID = process.env.BEDROCK_CLINIC_AGENT_ID || "";
const CLINIC_AGENT_ALIAS_ID = process.env.BEDROCK_CLINIC_AGENT_ALIAS_ID || "";
const PUBLIC_AGENT_ID = process.env.BEDROCK_PUBLIC_AGENT_ID || "";
const PUBLIC_AGENT_ALIAS_ID = process.env.BEDROCK_PUBLIC_AGENT_ALIAS_ID || "";

const bedrock = new BedrockAgentRuntimeClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });
const cognito = new CognitoIdentityProviderClient({ region: REGION });

const CLINIC_GROUPS_LOWER = new Set((CLINIC_ROLES as readonly string[]).map(g => g.toLowerCase()));

/**
 * Fetch the user's Cognito groups + derive the canonical agent type.
 * Source of truth for "is this a clinic or professional user?". Used to
 * override the frontend's requestedAgent if it disagrees with the JWT-side
 * truth (frontend reads localStorage.userRole, which can drift).
 */
async function resolveGroupsAndAgentType(userSub: string): Promise<{
  groups: string[];
  canonicalAgent: AgentType;
}> {
  if (!USER_POOL_ID) {
    console.warn("[chatMessage] USER_POOL_ID not set — cannot resolve groups; defaulting to professional");
    return { groups: [], canonicalAgent: "professional" };
  }
  try {
    const { AdminListGroupsForUserCommand } = await import("@aws-sdk/client-cognito-identity-provider");
    const groupsRes = await cognito.send(new AdminListGroupsForUserCommand({
      UserPoolId: USER_POOL_ID,
      Username: userSub,
    }));
    const groups = (groupsRes.Groups || []).map(g => g.GroupName || "").filter(Boolean);
    const isClinic = groups.some(g => CLINIC_GROUPS_LOWER.has(g.toLowerCase()));
    return { groups, canonicalAgent: isClinic ? "clinic" : "professional" };
  } catch (e) {
    console.warn("[chatMessage] resolveGroupsAndAgentType failed; defaulting to professional", e);
    return { groups: [], canonicalAgent: "professional" };
  }
}

interface ChatMessageFrame {
  action: "chatMessage";
  text: string;
  /** Required only on the first chatMessage of a connection; ignored thereafter. */
  agent?: AgentType;
}

interface ConfirmActionFrame {
  action: "confirmAction";
  /** A confirm_* tool name returned earlier in a confirm_card. */
  toolName: string;
  /** The exact payload the preview card was rendered with, plus `previewToken`. */
  payload: Record<string, any>;
}

type InboundFrame = ChatMessageFrame | ConfirmActionFrame;

const PROFESSIONAL_GROUPS_LOWER = new Set([
  "associatedentist", "dentalhygienist", "dentalassistant",
  "expandedfunctionsda", "dualrolefrontda", "patientcoordinatorfront",
  "treatmentcoordinatorfront", "dentist", "hygienist", "dhcomborole",
]);

const isClinicGroup = (g: string) => (CLINIC_ROLES as readonly string[]).includes(g.toLowerCase());
const isProfessionalGroup = (g: string) => PROFESSIONAL_GROUPS_LOWER.has(g.toLowerCase());

/**
 * First-message bootstrap.
 *
 * - `public`: connect-time JWT was skipped (websocketHandler.ts $connect lets
 *   `?agent=public` through). Mint an anon-<uuid> userSub; the public agent
 *   has no DB tool access so there's nothing to authorize against.
 * - `clinic` / `professional`: the existing WebSocket $connect handler
 *   already validated the JWT and stored an authenticated row in
 *   DentiPal-V5-Connections. We reverse-look that row up by connectionId via
 *   its connectionId-index GSI to recover userSub + userType.
 */
async function bootstrapSessionFromExistingConnection(
  connectionId: string,
  requestedAgent: AgentType,
): Promise<ChatSession | { error: string; status: number }> {
  if (requestedAgent === "public") {
    const anonSub = `anon-${connectionId.slice(0, 12)}`;
    return await createSessionForConnection(anonSub, connectionId, "public");
  }

  const res = await ddb.send(new QueryCommand({
    TableName: CONNS_TABLE,
    IndexName: "connectionId-index",
    KeyConditionExpression: "connectionId = :cid",
    ExpressionAttributeValues: { ":cid": { S: connectionId } },
    Limit: 1,
  }));
  const row = res.Items?.[0];
  if (!row || !row.sub?.S) {
    return { error: "No active authenticated connection found", status: 401 };
  }
  const userSub = row.sub.S;

  // Server-side agent-type derivation. Frontend reads localStorage.userRole
  // which can drift; the canonical truth is the user's Cognito groups. If
  // they disagree, override silently and log for observability.
  const { groups, canonicalAgent } = await resolveGroupsAndAgentType(userSub);
  const effectiveAgent: AgentType = canonicalAgent;
  if (canonicalAgent !== requestedAgent) {
    console.warn(`[chatMessage] agent override: requested=${requestedAgent} resolved=${canonicalAgent} userSub=${userSub} groups=[${groups.join(",")}]`);
  } else {
    console.log(`[chatMessage] bootstrap userSub=${userSub} agent=${effectiveAgent} groups=[${groups.join(",")}]`);
  }

  const session = await createSessionForConnection(userSub, connectionId, effectiveAgent);
  session.userGroups = groups;

  // Persist groups + canonical agent type so subsequent turns of this session
  // pick up the override on each refreshSession round-trip.
  try {
    await setUserGroupsAndAgentType(userSub, connectionId, groups, effectiveAgent);
  } catch (e) {
    console.warn("[chatMessage] setUserGroupsAndAgentType failed (continuing without persistent cache):", e);
  }

  // Pre-fetch user context (profile, address, clinics) once at bootstrap so
  // the agent can ground its first response without an extra round-trip.
  // Best-effort: a missing profile or geocode failure just yields a thinner
  // preamble; never blocks the session.
  try {
    const ctx = await fetchUserContext(userSub, effectiveAgent);
    if (ctx) {
      await setUserContext(userSub, connectionId, ctx as unknown as Record<string, any>);
      session.userContext = ctx as unknown as Record<string, any>;
    }
  } catch (e) {
    console.warn("[chatMessage] fetchUserContext failed (continuing without):", e);
  }

  return session;
}

const decoder = new TextDecoder("utf-8");

/**
 * Looks up which Bedrock agent + alias to invoke for a given session's agentType.
 */
function getAgentTarget(agentType: string): { agentId: string; agentAliasId: string } | null {
  switch (agentType) {
    case "professional":
      if (!PROFESSIONAL_AGENT_ID || !PROFESSIONAL_AGENT_ALIAS_ID) return null;
      return { agentId: PROFESSIONAL_AGENT_ID, agentAliasId: PROFESSIONAL_AGENT_ALIAS_ID };
    case "clinic":
      if (!CLINIC_AGENT_ID || !CLINIC_AGENT_ALIAS_ID) return null;
      return { agentId: CLINIC_AGENT_ID, agentAliasId: CLINIC_AGENT_ALIAS_ID };
    case "public":
      if (!PUBLIC_AGENT_ID || !PUBLIC_AGENT_ALIAS_ID) return null;
      return { agentId: PUBLIC_AGENT_ID, agentAliasId: PUBLIC_AGENT_ALIAS_ID };
    default:
      return null;
  }
}

/**
 * Build the API Gateway Management API client for the current WebSocket
 * connection. Endpoint is derived from the request context so the same Lambda
 * works across stages.
 */
function buildApiGwClient(event: any): ApiGatewayManagementApiClient {
  const domain = event.requestContext?.domainName;
  const stage = event.requestContext?.stage;
  if (!domain || !stage) throw new Error("Missing WebSocket request context for PostToConnection");
  return new ApiGatewayManagementApiClient({
    region: REGION,
    endpoint: `https://${domain}/${stage}`,
  });
}

/**
 * Push a frame to the connected client. Swallows GoneException (client closed
 * the socket) so a dead client doesn't abort the rest of the handler.
 */
async function postFrame(
  api: ApiGatewayManagementApiClient,
  connectionId: string,
  frame: Record<string, any>,
): Promise<void> {
  try {
    await api.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(frame)),
    }));
  } catch (err) {
    if (err instanceof GoneException) {
      console.warn(`postFrame: connection ${connectionId} is gone`);
      return;
    }
    throw err;
  }
}

/**
 * chatMessage route handler.
 *
 * Flow:
 *   1. Resolve session row (and refresh TTL).
 *   2. Parse the incoming frame.
 *   3. Invoke Bedrock AgentCore for the session's agentType, with the same
 *      bedrockSessionId carried across turns.
 *   4. Iterate the streaming response:
 *        - `chunk` events → forward as `{type:"token", delta}` frames.
 *        - `returnControl` events → execute the requested tool via
 *          toolExecutor, then continue the conversation by re-invoking with
 *          `sessionState.returnControlInvocationResults`. The model resumes
 *          where it stopped.
 *        - `trace` events → optionally forward as `{type:"trace", ...}` for
 *          debug; redacted in prod.
 *   5. Send a terminal `{type:"final", ...}` frame when the stream ends.
 *
 * Errors:
 *   - Session not found / expired → `{type:"error", reason:"session_expired"}`.
 *     Client should drop the socket and reconnect (server's $disconnect will
 *     fire automatically; the new $connect mints a fresh row).
 *   - Bedrock error → `{type:"error", reason:"agent_failure"}`.
 *   - Tool error → forwarded as `{type:"toolResult", ok:false, ...}` and the
 *     model is given the error so it can recover gracefully.
 */
export const handler = async (event: any): Promise<APIGatewayProxyResult> => {
  const connectionId: string | undefined = event.requestContext?.connectionId;
  if (!connectionId) {
    console.error("chatMessage: missing connectionId");
    return { statusCode: 400, body: "Missing connectionId" };
  }

  const api = buildApiGwClient(event);

  // Outer guard: catch ANY uncaught exception from the body below so the
  // client never sees API Gateway's default malformed error frame (which
  // the widget renders as `Error (undefined)`). Always 200 to API Gateway —
  // the user-visible failure is the error frame we send ourselves.
  try {
    return await handlerBody(connectionId, api, event);
  } catch (outerErr: any) {
    console.error("[chatMessage] outermost unhandled exception", outerErr);
    try {
      await postFrame(api, connectionId, {
        type: "error",
        reason: "internal_error",
        detail: outerErr?.message || String(outerErr) || "Uncaught exception",
      });
    } catch (postErr) {
      console.error("[chatMessage] error frame post itself failed", postErr);
    }
    return { statusCode: 200, body: "ok" };
  }
};

async function handlerBody(
  connectionId: string,
  api: ApiGatewayManagementApiClient,
  event: any,
): Promise<APIGatewayProxyResult> {

  // ---- 1. Parse frame ----
  let frame: InboundFrame;
  try {
    frame = JSON.parse(event.body || "{}");
  } catch {
    await postFrame(api, connectionId, { type: "error", reason: "invalid_json" });
    return { statusCode: 400, body: "Invalid JSON" };
  }
  console.log(`[chatMessage] inbound frame: action=${(frame as any)?.action} toolName=${(frame as any)?.toolName ?? "(n/a)"} connectionId=${connectionId}`);
  if (frame.action !== "chatMessage" && frame.action !== "confirmAction") {
    await postFrame(api, connectionId, { type: "error", reason: "invalid_frame" });
    return { statusCode: 400, body: "Invalid frame" };
  }
  if (frame.action === "chatMessage" && (!frame.text || typeof frame.text !== "string")) {
    await postFrame(api, connectionId, { type: "error", reason: "invalid_frame", detail: "chatMessage requires text" });
    return { statusCode: 400, body: "Invalid frame" };
  }
  if (frame.action === "confirmAction" && (!frame.toolName?.startsWith("confirm_") || !frame.payload)) {
    await postFrame(api, connectionId, { type: "error", reason: "invalid_frame", detail: "confirmAction requires toolName (confirm_*) and payload" });
    return { statusCode: 400, body: "Invalid frame" };
  }

  // ---- 2. Load or bootstrap session ----
  let session = await getSessionByConnectionId(connectionId);
  if (!session) {
    // Bootstrap requires a chatMessage with explicit `agent`. A confirmAction
    // can only happen mid-conversation so its session must already exist.
    if (frame.action !== "chatMessage") {
      await postFrame(api, connectionId, { type: "error", reason: "session_expired" });
      return { statusCode: 410, body: "session_expired" };
    }
    const requestedAgent = (frame.agent || "").toLowerCase() as AgentType;
    if (requestedAgent !== "clinic" && requestedAgent !== "professional" && requestedAgent !== "public") {
      await postFrame(api, connectionId, {
        type: "error",
        reason: "agent_required",
        detail: "First chatMessage must include 'agent': 'professional' | 'clinic' | 'public'",
      });
      return { statusCode: 400, body: "agent required" };
    }
    const bootstrap = await bootstrapSessionFromExistingConnection(connectionId, requestedAgent);
    if ("error" in bootstrap) {
      await postFrame(api, connectionId, { type: "error", reason: "unauthorized", detail: bootstrap.error });
      return { statusCode: bootstrap.status, body: bootstrap.error };
    }
    session = bootstrap;
  } else {
    try {
      await refreshSession(session.userSub, connectionId);
    } catch (err) {
      console.warn("chatMessage: refreshSession failed (session may have just expired):", err);
    }
  }

  // ---- 2b. confirmAction shortcut: bypass the LLM, run the confirm_* tool directly ----
  if (frame.action === "confirmAction") {
    console.log(`[chatMessage] confirmAction enter — toolName=${frame.toolName} payloadKeys=${Object.keys(frame.payload || {}).join(",")} userSub=${session.userSub}`);
    try {
      const auth: AuthContext = {
        userSub: session.userSub,
        userGroups: session.userGroups || [],
        userType: session.agentType === "clinic" ? "clinic" : session.agentType === "professional" ? "professional" : "public",
      };
      const result = await executeTool(
        { toolName: frame.toolName, input: frame.payload },
        auth,
        connectionId,
        session.userContext as any,
      );
      console.log(`[chatMessage] confirmAction result — tool=${frame.toolName} ok=${result.ok} error=${result.ok ? "(none)" : result.error}`);
      await postFrame(api, connectionId, {
        type: "toolResult",
        tool: frame.toolName,
        ok: result.ok,
        data: result.ok ? result.data : undefined,
        // Guarantee a non-empty error string so the widget renders a usable
        // message rather than the dreaded "undefined".
        error: result.ok ? undefined : (result.error || "Tool returned no error detail"),
      });
      await postFrame(api, connectionId, { type: "final", stopReason: "user_confirmed" });
      return { statusCode: 200, body: "ok" };
    } catch (err: any) {
      console.error("[chatMessage] confirmAction unhandled error", err);
      // Best-effort error frame so the widget shows something specific
      // instead of falling back to "Error (undefined)". If postFrame itself
      // is what threw, the inner try silently swallows that — nothing more
      // we can do at that point.
      try {
        await postFrame(api, connectionId, {
          type: "error",
          reason: "confirm_failed",
          detail: err?.message || String(err) || "Unknown confirm error",
        });
      } catch (postErr) {
        console.error("[chatMessage] postFrame error frame ALSO failed", postErr);
      }
      return { statusCode: 500, body: "confirm_failed" };
    }
  }

  // ---- 3. Resolve Bedrock target ----
  const target = getAgentTarget(session.agentType);
  if (!target) {
    console.error(`chatMessage: no Bedrock agent configured for agentType=${session.agentType}`);
    await postFrame(api, connectionId, {
      type: "error",
      reason: "agent_not_configured",
      detail: `No Bedrock agent ID set for '${session.agentType}'`,
    });
    return { statusCode: 500, body: "Agent not configured" };
  }

  // Auth context handed to every tool invocation. For the public agent we use
  // the synthetic anon-* userSub the connect handler stored.
  const auth: AuthContext = {
    userSub: session.userSub,
    userGroups: session.userGroups || [],
    userType: session.agentType === "clinic" ? "clinic" : session.agentType === "professional" ? "professional" : "public",
  };

  // ---- 4. Invoke Bedrock and stream ----
  // The early `return` above for `confirmAction` means we're now guaranteed
  // dealing with a `chatMessage` frame, but TS doesn't always narrow through
  // the if-return — assert explicitly.
  const userText = (frame as ChatMessageFrame).text;

  // First turn of the 15-min session: prepend a one-time user-context preamble
  // so the agent grounds itself in who's talking, their role, home address,
  // and which clinics they manage. Subsequent turns send the raw user text;
  // Bedrock keeps the preamble in the session memory keyed by bedrockSessionId.
  let firstTurnText = userText;
  if (!session.contextInjected && session.userContext) {
    try {
      const preamble = renderContextPreamble(session.userContext as unknown as UserContext);
      firstTurnText = `${preamble}\n\nUser said: ${userText}`;
      await markContextInjected(session.userSub, connectionId);
    } catch (e) {
      console.warn("[chatMessage] renderContextPreamble failed (continuing without):", e);
    }
  }

  try {
    let inputText: string | undefined = firstTurnText;
    let returnControlInvocationResults: any[] | undefined;
    let invocationId: string | undefined;

    // The agent may need multiple "turns" within one user message if it calls
    // multiple tools. Cap at 6 to prevent runaway loops.
    const MAX_TOOL_LOOPS = 6;

    for (let loop = 0; loop < MAX_TOOL_LOOPS; loop++) {
      const command = new InvokeAgentCommand({
        agentId: target.agentId,
        agentAliasId: target.agentAliasId,
        sessionId: session.bedrockSessionId,
        inputText: returnControlInvocationResults ? undefined : inputText,
        sessionState: returnControlInvocationResults
          ? {
              invocationId,
              returnControlInvocationResults,
            }
          : undefined,
        // Trace enabled: surfaces guardrail decisions, model rationale, and
        // any safety-decline cause in the event stream. Required to diagnose
        // canned "Sorry, I am unable to assist..." responses — without trace
        // we only see the user-facing text and have no idea why.
        enableTrace: true,
      });

      console.log(`[chatMessage] InvokeAgent loop=${loop} sessionId=${session.bedrockSessionId} hasReturnControl=${!!returnControlInvocationResults} inputText="${(inputText || "").slice(0, 120)}"`);

      const response = await bedrock.send(command);
      if (!response.completion) {
        await postFrame(api, connectionId, { type: "error", reason: "empty_completion" });
        break;
      }

      let pendingToolCalls: ToolCall[] = [];
      let pendingInvocationId: string | undefined;
      let assistantTextThisTurn = "";

      for await (const event of response.completion) {
        if (event.chunk?.bytes) {
          const delta = decoder.decode(event.chunk.bytes);
          assistantTextThisTurn += delta;
          await postFrame(api, connectionId, { type: "token", delta });
          continue;
        }

        if (event.returnControl) {
          pendingInvocationId = event.returnControl.invocationId;
          const inputs = event.returnControl.invocationInputs || [];
          for (const inv of inputs) {
            const fn = inv.functionInvocationInput;
            if (fn?.function) {
              const params: Record<string, any> = {};
              for (const p of fn.parameters || []) {
                if (p.name) params[p.name] = coerceParam(p.value, p.type);
              }
              pendingToolCalls.push({
                toolName: fn.function,
                input: params,
                // Echo the EXACT action-group name back in functionResult.
                // With chunked groups (DentiPalProTools1/2/3) hardcoding is wrong.
                actionGroup: fn.actionGroup,
              });
            }
          }
        }

        // Trace events — log a compact view so we can see what Bedrock was
        // actually doing on every turn. The trace object is deep; stringify
        // and truncate to keep the log bytes reasonable.
        if (event.trace) {
          try {
            const t = event.trace;
            const truncated = JSON.stringify(t).slice(0, 1800);
            console.log(`[chatMessage] trace loop=${loop}: ${truncated}`);
          } catch {
            console.log(`[chatMessage] trace loop=${loop}: <unserializable>`);
          }
        }

        // Catch any other unhandled event keys.
        const knownKeys = new Set(["chunk", "returnControl", "trace"]);
        const unknown = Object.keys(event).filter((k) => !knownKeys.has(k));
        if (unknown.length > 0) {
          console.log(`[chatMessage] unknown event keys loop=${loop}: ${unknown.join(",")} payload=${JSON.stringify(event).slice(0, 800)}`);
        }
      }

      console.log(`[chatMessage] turn complete loop=${loop} pendingToolCalls=${pendingToolCalls.length} assistantTextLen=${assistantTextThisTurn.length} text="${assistantTextThisTurn.slice(0, 200)}"`);

      // No tool calls => assistant turn is complete.
      if (pendingToolCalls.length === 0) {
        await postFrame(api, connectionId, { type: "final", stopReason: "end_turn" });
        return { statusCode: 200, body: "ok" };
      }

      // Execute every tool the agent asked for, forward results to client,
      // then feed them back into Bedrock for the next loop.
      const results: any[] = [];
      for (const call of pendingToolCalls) {
        const result = await executeTool(call, auth, connectionId, session.userContext as any);
        await postFrame(api, connectionId, {
          type: "toolResult",
          tool: call.toolName,
          ok: result.ok,
          data: result.ok ? result.data : undefined,
          error: result.ok ? undefined : result.error,
        });
        results.push({
          functionResult: {
            actionGroup: call.actionGroup || 'DentiPalProTools1', // fallback, but should always be set
            function: call.toolName,
            responseBody: {
              TEXT: {
                body: JSON.stringify(result.ok ? result.data : { error: result.error }),
              },
            },
          },
        });
      }

      // Re-enter the loop with tool results so the model can keep reasoning.
      invocationId = pendingInvocationId;
      returnControlInvocationResults = results;
      inputText = undefined;
    }

    // Hit the loop cap.
    await postFrame(api, connectionId, {
      type: "error",
      reason: "tool_loop_cap",
      detail: `Agent exceeded ${MAX_TOOL_LOOPS} tool-call rounds in one turn`,
    });
    return { statusCode: 200, body: "ok" };

  } catch (err: any) {
    console.error("chatMessage: Bedrock invoke failed", err);
    await postFrame(api, connectionId, {
      type: "error",
      reason: "agent_failure",
      detail: err?.message || "Bedrock InvokeAgent failed",
    });
    return { statusCode: 500, body: err?.message || "agent_failure" };
  }
};

function coerceParam(value: string | undefined, type: string | undefined): any {
  if (value === undefined || value === null) return undefined;
  const t = (type || "").toLowerCase();
  if (t === "number" || t === "integer") {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (t === "boolean") return value === "true";
  if (t === "array" || t === "object") {
    try { return JSON.parse(value); } catch { return value; }
  }
  return value;
}

