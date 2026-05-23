import { APIGatewayProxyResult } from "aws-lambda";
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
  AgentType,
  ChatSession,
} from "./sessionStore";
import { executeTool } from "./toolExecutor";
import { fetchUserContext } from "./userContext";
import { writeMemoryEvent, ConversationTurn } from "./agentCoreMemory";
import { writeTurn as writeChatHistoryTurn, legacyConversationId } from "./chatHistoryStore";
import { AuthContext, CLINIC_ROLES } from "../utils";
// Every chat turn routes through AgentCore Runtime (WS-4 agents). The
// runtimeInvoker translates Runtime SSE events into WS frames the widget
// already understands.
import { getRuntimeArn, invokeAgentRuntime } from "./runtimeInvoker";

const REGION = process.env.REGION || "us-east-1";
const CONNS_TABLE = process.env.CONNS_TABLE || "DentiPal-V5-Connections"; // existing user-to-user table
const USER_POOL_ID = process.env.USER_POOL_ID || "";

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
  /** Optional. WS-7 frontend (conversation sidebar) sends one per frame so
   *  the transcript row gets persisted under that conversationId. Pre-WS-5
   *  this is the only path that lets multi-conversation sidebars work —
   *  the chat session itself is still single, but each frame's writes are
   *  scoped to whichever conversation the user has open. Omitted by old
   *  frontends → server falls back to legacy-<userSub>. */
  conversationId?: string;
}

interface ConfirmActionFrame {
  action: "confirmAction";
  /** A confirm_* tool name returned earlier in a confirm_card. */
  toolName: string;
  /** The exact payload the preview card was rendered with, plus `previewToken`. */
  payload: Record<string, any>;
  /** Same as chatMessage — scopes the synthesized "Confirmed: …" memory
   *  event to the right conversation when the user clicks a confirm card. */
  conversationId?: string;
}

type InboundFrame = ChatMessageFrame | ConfirmActionFrame;

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
    // Must match the anon sub written by websocketHandler.onConnect's public
    // branch (anon-<connectionId>, no truncation) so downstream lookups by
    // sub line up. Don't read the Connections row here — the public path has
    // no useful claims to extract beyond the sub, which we already know.
    const anonSub = `anon-${connectionId}`;
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

/**
 * Construct the per-invocation ApiGatewayManagementApi client for posting
 * frames back to the WebSocket connection.
 *
 * IMPORTANT: must use the RAW `<api-id>.execute-api.<region>.amazonaws.com`
 * host, NOT `event.requestContext.domainName`. For this stack `domainName`
 * is the custom domain `ws.dentipal.com`, which has a base-path mapping that
 * already prepends `/prod` — appending another `/${stage}` produces
 * `/prod/prod/@connections/...` and AWS rejects it as
 * "AccessDenied execute-api:Invoke" (confusing error, real cause is the
 * malformed URL — see CDK env-var comment).
 *
 * `WEBSOCKET_API_ID` is set by CDK exactly for this construction.
 */
const WEBSOCKET_API_ID = process.env.WEBSOCKET_API_ID || "";

function buildApiGwClient(event: any): ApiGatewayManagementApiClient {
  const stage = event?.requestContext?.stage || "prod";
  // Prefer the env-var-provided raw API id. Fall back to requestContext.apiId
  // (also raw) if the env var ever goes missing — never use domainName.
  const apiId = WEBSOCKET_API_ID || event?.requestContext?.apiId;
  const endpoint = `https://${apiId}.execute-api.${REGION}.amazonaws.com/${stage}`;
  return new ApiGatewayManagementApiClient({
    region: REGION,
    endpoint,
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
    // Bootstrap is turn 1 — the new row has no messageCount yet. Treat it
    // as 1 for the cap math below.
    session.messageCount = 1;
  } else {
    try {
      const newCount = await refreshSession(session.userSub, connectionId);
      if (typeof newCount === "number") session.messageCount = newCount;
    } catch (err) {
      console.warn("chatMessage: refreshSession failed (session may have just expired):", err);
    }
  }

  // ---- 2a. Public-session message cap ----
  // Unauthenticated public sessions are capped at 20 user turns to bound
  // Bedrock cost from drive-by abuse. Authenticated agents skip this — they
  // already cleared Cognito auth and are inherently rate-limited by humans.
  // confirmAction frames don't burn Bedrock credits (they bypass the LLM),
  // so they're allowed past the cap.
  const PUBLIC_MESSAGE_CAP = 20;
  if (
    session.agentType === "public" &&
    frame.action === "chatMessage" &&
    (session.messageCount ?? 1) > PUBLIC_MESSAGE_CAP
  ) {
    await postFrame(api, connectionId, {
      type: "error",
      reason: "rate_limited",
      detail: `Public chat limit reached (${PUBLIC_MESSAGE_CAP} messages per session). Sign in for unlimited access, or refresh the page to start a new session.`,
    });
    return { statusCode: 429, body: "rate_limited" };
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
      // Record the confirmation in AgentCore Memory ONLY — so the agent's
      // future sessions know what the user confirmed ("did I post that
      // shift last week?"). We do NOT write to the user-facing transcript
      // (ChatMessages) because the confirm payload is a machine string
      // ("confirm_post_temporary_job ({...JSON...})") that has no business
      // appearing alongside the natural-language USER/ASSISTANT turns. The
      // toolResult frame still streams to the live session for real-time
      // feedback; transcript readers see the preceding "Review the details
      // and click Confirm." line and infer continuation from the next turn.
      //
      // Role is USER in memory because clicking "confirm" is a user action;
      // TOOL is reserved for actual model-emitted tool-output payloads.
      if (session.agentType !== "public" && result.ok) {
        const summaryText = `Confirmed: ${frame.toolName} (${JSON.stringify(frame.payload || {}).slice(0, 400)})`;
        void writeMemoryEvent(session.userSub, session.bedrockSessionId, [
          { role: "USER", text: summaryText },
        ]).catch((e) => console.warn("[chatMessage] confirm memory write failed:", e));
      }
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

  // Auth context handed to every tool invocation. For the public agent we use
  // the synthetic anon-* userSub the connect handler stored.
  const auth: AuthContext = {
    userSub: session.userSub,
    userGroups: session.userGroups || [],
    userType: session.agentType === "clinic" ? "clinic" : session.agentType === "professional" ? "professional" : "public",
  };

  // ---- 3. Route to AgentCore Runtime ----
  // Single path now — the legacy Bedrock Agents InvokeAgentCommand loop
  // was removed when the runtime took over. If the per-agentType runtime
  // ARN env var is missing (misconfigured deploy), error out loudly so
  // the user sees something specific instead of a silent hang.
  const runtimeArn = getRuntimeArn(session.agentType);
  if (!runtimeArn) {
    console.error(`chatMessage: no runtime ARN configured for agentType=${session.agentType}`);
    await postFrame(api, connectionId, {
      type: "error",
      reason: "runtime_not_configured",
      detail: `No BEDROCK_RUNTIME_*_ARN env var set for '${session.agentType}'`,
    });
    return { statusCode: 500, body: "Runtime not configured" };
  }
  return await invokeViaRuntime({ runtimeArn, session, auth, frame, api, connectionId });
};

/**
 * WS-5 branch: route the turn through AgentCore Runtime (LangGraph agent
 * containers from WS-4) instead of the legacy Bedrock Agents loop.
 *
 * The runtime owns the plan/execute/reflect loop, tool calls (via Gateway
 * MCP), and memory hydrate. This Lambda becomes a thin transport:
 *   1. Build the invocation payload (auth, conversationId, user text).
 *   2. Stream the runtime's SSE events back as WS frames.
 *   3. Persist the turn pair to ChatMessages + AgentCore Memory once
 *      streaming settles — same fire-and-forget pattern the legacy path
 *      uses, so transcript continuity is preserved across paths.
 *
 * runtimeSessionId is the per-conversation id from the WS frame (or the
 * legacy fallback). Same conversation reuses the same warm runtime
 * container; different conversations get fresh sessions so working memory
 * doesn't leak across them.
 */
async function invokeViaRuntime(opts: {
  runtimeArn: string;
  session: ChatSession;
  auth: AuthContext;
  frame: InboundFrame;
  api: ApiGatewayManagementApiClient;
  connectionId: string;
}): Promise<APIGatewayProxyResult> {
  const { runtimeArn, session, auth, frame, api, connectionId } = opts;
  // Confirm path is unreachable here — handlerBody returned earlier for
  // confirmAction frames. Narrow explicitly.
  const userText = (frame as ChatMessageFrame).text;
  const conversationId =
    (frame as ChatMessageFrame).conversationId || legacyConversationId(session.userSub);

  // runtimeSessionId: use the conversationId so all turns in one
  // conversation share a runtime session (warm container, persistent
  // working memory). AgentCore Runtime keys session storage by this id.
  const runtimeSessionId = conversationId;

  // Forward the cached clinics list so the runtime's MCP tools can
  // resolve clinic names → UUIDs without an extra round-trip. The user
  // context cache is populated at session bootstrap.
  const clinics = ((session.userContext as any)?.clinics || []) as Array<{ clinicId: string; name?: string }>;

  try {
    const { assistantText, stopReason } = await invokeAgentRuntime({
      runtimeArn,
      runtimeSessionId,
      userText,
      identity: {
        userSub: auth.userSub,
        userType: session.agentType,
        userGroups: auth.userGroups || [],
        email: auth.email,
        clinics,
      },
      conversationId,
      api,
      connectionId,
    });

    // Persist the turn (fire-and-forget, mirrors the legacy path).
    if (session.agentType !== "public" && assistantText.trim()) {
      const turns: ConversationTurn[] = [
        { role: "USER", text: userText },
        { role: "ASSISTANT", text: assistantText },
      ];
      void writeMemoryEvent(session.userSub, session.bedrockSessionId, turns)
        .catch((e) => console.warn(`[chatMessage:WS-5] memory write (${stopReason}) failed:`, e));
    }
    void writeChatHistoryTurn({
      userSub: session.userSub,
      conversationId,
      sessionId: session.bedrockSessionId,
      userText,
      assistantText,
      agentType: session.agentType,
    }).catch((e) => console.warn(`[chatMessage:WS-5] chat-history write (${stopReason}) failed:`, e));

    return { statusCode: 200, body: "ok" };
  } catch (err: any) {
    console.error("[chatMessage:WS-5] InvokeAgentRuntime failed", err);
    await postFrame(api, connectionId, {
      type: "error",
      reason: "runtime_failure",
      detail: err?.message || "InvokeAgentRuntime failed",
    });
    return { statusCode: 500, body: err?.message || "runtime_failure" };
  }
}


