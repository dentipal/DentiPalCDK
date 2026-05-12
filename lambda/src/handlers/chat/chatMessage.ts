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
  getSessionByConnectionId,
  refreshSession,
  createSessionForConnection,
  setUserContext,
  markContextInjected,
  AgentType,
  ChatSession,
} from "./sessionStore";
import { executeTool, ToolCall } from "./toolExecutor";
import { fetchUserContext, renderContextPreamble, UserContext } from "./userContext";
import { AuthContext, CLINIC_ROLES } from "../utils";

const REGION = process.env.REGION || "us-east-1";
const CONNS_TABLE = process.env.CONNS_TABLE || "DentiPal-V5-Connections"; // existing user-to-user table

const PROFESSIONAL_AGENT_ID = process.env.BEDROCK_PROFESSIONAL_AGENT_ID || "";
const PROFESSIONAL_AGENT_ALIAS_ID = process.env.BEDROCK_PROFESSIONAL_AGENT_ALIAS_ID || "";
const CLINIC_AGENT_ID = process.env.BEDROCK_CLINIC_AGENT_ID || "";
const CLINIC_AGENT_ALIAS_ID = process.env.BEDROCK_CLINIC_AGENT_ALIAS_ID || "";
const PUBLIC_AGENT_ID = process.env.BEDROCK_PUBLIC_AGENT_ID || "";
const PUBLIC_AGENT_ALIAS_ID = process.env.BEDROCK_PUBLIC_AGENT_ALIAS_ID || "";

const bedrock = new BedrockAgentRuntimeClient({ region: REGION });
const ddb = new DynamoDBClient({ region: REGION });

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
  // We trust the frontend's agent-type routing (it picks based on
  // localStorage.userRole which is set at login time). The Connections-row
  // userType field has inconsistent casing/values across user types and
  // attempting strict server-side matching here just creates false denies.
  // Per-tool RBAC (canWriteClinic etc.) is the real gate downstream — that
  // gate runs inside each refactored handler and is the security boundary.
  // Log the value for observability.
  console.log(`[chatMessage] bootstrap userSub=${userSub} requestedAgent=${requestedAgent} userType="${row.userType?.S || "<empty>"}"`);

  const session = await createSessionForConnection(userSub, connectionId, requestedAgent);

  // Pre-fetch user context (profile, address, clinics) once at bootstrap so
  // the agent can ground its first response without an extra round-trip.
  // Best-effort: a missing profile or geocode failure just yields a thinner
  // preamble; never blocks the session.
  try {
    const ctx = await fetchUserContext(userSub, requestedAgent);
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

  // ---- 1. Parse frame ----
  let frame: InboundFrame;
  try {
    frame = JSON.parse(event.body || "{}");
  } catch {
    await postFrame(api, connectionId, { type: "error", reason: "invalid_json" });
    return { statusCode: 400, body: "Invalid JSON" };
  }
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
    const auth: AuthContext = {
      userSub: session.userSub,
      userGroups: [],
      userType: session.agentType === "clinic" ? "clinic" : session.agentType === "professional" ? "professional" : "public",
    };
    const result = await executeTool(
      { toolName: frame.toolName, input: frame.payload },
      auth,
      connectionId,
      session.userContext as any,
    );
    await postFrame(api, connectionId, {
      type: "toolResult",
      tool: frame.toolName,
      ok: result.ok,
      data: result.ok ? result.data : undefined,
      error: result.ok ? undefined : result.error,
    });
    await postFrame(api, connectionId, { type: "final", stopReason: "user_confirmed" });
    return { statusCode: 200, body: "ok" };
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
    userGroups: [], // Phase 1: agent-level scoping handled at $connect; per-tool group checks live in the run* fns.
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
        enableTrace: false,
      });

      const response = await bedrock.send(command);
      if (!response.completion) {
        await postFrame(api, connectionId, { type: "error", reason: "empty_completion" });
        break;
      }

      let pendingToolCalls: ToolCall[] = [];
      let pendingInvocationId: string | undefined;

      for await (const event of response.completion) {
        if (event.chunk?.bytes) {
          const delta = decoder.decode(event.chunk.bytes);
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
      }

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

