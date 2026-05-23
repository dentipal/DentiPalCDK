/**
 * REST API for chatbot conversation management.
 *
 * Backs the Claude.ai-style sidebar: list / create / rename / archive /
 * delete / read transcript / search. One row per conversation lives in
 * DentiPal-V5-ChatConversations; transcript rows live in ChatMessages,
 * filtered by conversationId via the conversationId-ts-index GSI.
 *
 * All endpoints require a Cognito access token. Public/anon users have no
 * persistent conversations (their userSub rotates per connection), so they
 * get 401 here and continue to chat ephemerally via the WebSocket only.
 *
 * Each named export below is wired to a route entry in lambda/src/index.ts:
 *
 *   GET    /chat/conversations                          → listConversationsHandler
 *   POST   /chat/conversations                          → createConversationHandler
 *   GET    /chat/conversations/{conversationId}         → getConversationHandler
 *   PATCH  /chat/conversations/{conversationId}         → patchConversationHandler
 *   DELETE /chat/conversations/{conversationId}         → deleteConversationHandler
 *   GET    /chat/conversations/{conversationId}/messages → getConversationMessagesHandler
 *   GET    /chat/conversations/search                   → searchConversationsHandler
 *   POST   /chat/conversations/{conversationId}/regenerate-title → regenerateTitleHandler
 *
 * The search endpoint is Phase-1 (keyword + recency over titles). Semantic
 * search via OpenSearch Serverless is intentionally deferred — see the
 * plan's "out of scope" section.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { corsHeaders } from "../corsHeaders";
import { extractUserFromBearerToken } from "../utils";
import {
  createConversation,
  getConversation,
  listConversations,
  patchConversation,
  deleteConversation,
  AgentRoute,
} from "./conversationStore";
import {
  listChatMessagesByConversation,
  clearChatMessagesByConversation,
} from "./chatHistoryStore";

// ───────────────────────────────────────────────────────────────────────
// Plumbing
// ───────────────────────────────────────────────────────────────────────

const json = (
  event: APIGatewayProxyEvent,
  statusCode: number,
  body: unknown,
): APIGatewayProxyResult => ({
  statusCode,
  headers: { ...corsHeaders(event), "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

const preflight = (event: APIGatewayProxyEvent): APIGatewayProxyResult | null => {
  const method = event.httpMethod || (event as any).requestContext?.http?.method || "";
  if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };
  return null;
};

interface CallerAuth {
  userSub: string;
  agentRoute: AgentRoute;
}

/**
 * Resolve the caller's userSub + agent route from the Authorization header.
 *
 * - Missing / invalid bearer → 401.
 * - Internal/admin groups → 403 (the chatbot isn't a feature for them).
 * - Otherwise return one of "clinic" | "professional" — derived from
 *   userType already computed by extractUserFromBearerToken (which falls
 *   back through `custom:user_type` → parsed address → Cognito groups).
 *
 * `public` is never returned here because the REST endpoints aren't reachable
 * without a JWT; anon visitors keep using the WebSocket-only ephemeral path.
 */
function authenticate(event: APIGatewayProxyEvent): CallerAuth | APIGatewayProxyResult {
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) return json(event, 401, { error: "Missing Authorization header" });

  let info: { sub: string; userType?: string };
  try {
    info = extractUserFromBearerToken(authHeader);
  } catch (e: any) {
    return json(event, 401, { error: `Invalid bearer token: ${e?.message || "unknown"}` });
  }
  if (!info?.sub) return json(event, 401, { error: "Unable to derive userSub from token" });

  const userType = (info.userType || "").toLowerCase();
  if (userType === "clinic") return { userSub: info.sub, agentRoute: "clinic" };
  if (userType === "professional") return { userSub: info.sub, agentRoute: "professional" };
  // "internal" / "" — admin or unknown role. Chatbot conversations aren't a
  // surface they have; reject with 403 rather than guessing.
  return json(event, 403, { error: `Chatbot not available for userType="${userType || "unknown"}"` });
}

/** Convenience: `auth` is either the resolved caller or the error response. */
function isError(x: CallerAuth | APIGatewayProxyResult): x is APIGatewayProxyResult {
  return (x as APIGatewayProxyResult).statusCode !== undefined;
}

function pathParam(event: APIGatewayProxyEvent, name: string): string | undefined {
  // First try the canonical pathParameters (populated by API Gateway when
  // routes are defined with parameterized resources directly).
  const v = event.pathParameters?.[name];
  if (typeof v === "string" && v.length > 0) return v;

  // Fallback: this monolith routes through a `{proxy+}` catch-all so
  // pathParameters is empty for every parameterized route. The custom
  // router in index.ts matches the URL against `{conversationId}` patterns
  // for dispatch but never extracts the value. Parse it from the URL
  // ourselves so getConversation / patch / delete / getMessages / regenerate-
  // title all work end-to-end. Without this the sidebar can list rows but
  // clicking one returns 400 "Missing conversationId path param".
  if (name === "conversationId") {
    const rawPath = (event as any).path || (event as any).rawPath || "";
    const m = rawPath.match(/\/chat\/conversations\/([^\/?]+)/);
    // "search" is a literal sibling route, not a UUID — guard against it.
    if (m && m[1] && m[1] !== "search") {
      try { return decodeURIComponent(m[1]); }
      catch { return m[1]; }
    }
  }
  return undefined;
}

function parseJsonBody(event: APIGatewayProxyEvent): Record<string, any> {
  try {
    return event.body ? JSON.parse(event.body) : {};
  } catch {
    return {};
  }
}

// ───────────────────────────────────────────────────────────────────────
// Handlers
// ───────────────────────────────────────────────────────────────────────

/**
 * GET /chat/conversations?limit=50&before=<iso>&includeArchived=false
 *
 * Sidebar list — newest-first by lastMessageAt, paginated via the
 * userSub-lastMessageAt-index GSI.
 */
export const listConversationsHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const qs = event.queryStringParameters || {};
  const limit = Math.max(1, Math.min(200, Number(qs.limit) || 50));
  const before = typeof qs.before === "string" && qs.before.length > 0 ? qs.before : undefined;
  const includeArchived = qs.includeArchived === "true";

  const page = await listConversations(auth.userSub, { limit, before, includeArchived });
  return json(event, 200, page);
};

/**
 * POST /chat/conversations
 *
 * Body: (optional) { title?: string }
 *
 * Mints a new conversation row; agentRoute is server-derived from Cognito
 * groups (never trusted from the body). Returns the freshly-written row.
 */
export const createConversationHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const body = parseJsonBody(event);
  const title = typeof body.title === "string" ? body.title.slice(0, 200) : undefined;

  const conv = await createConversation({
    userSub: auth.userSub,
    agentRoute: auth.agentRoute,
    title,
  });
  return json(event, 201, conv);
};

/**
 * GET /chat/conversations/{conversationId}
 *
 * Single-row read; 404 if not found OR if the row belongs to a different
 * user (the composite-key lookup with the caller's userSub naturally
 * sandboxes this — no cross-user reads possible).
 */
export const getConversationHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const conversationId = pathParam(event, "conversationId");
  if (!conversationId) return json(event, 400, { error: "Missing conversationId path param" });

  const conv = await getConversation(auth.userSub, conversationId);
  if (!conv) return json(event, 404, { error: "Conversation not found" });
  return json(event, 200, conv);
};

/**
 * PATCH /chat/conversations/{conversationId}
 *
 * Body: { title?, isArchived?, isPinned? }
 *
 * Whitelist patch — only the listed fields can be changed. `agentRoute`,
 * `runtimeSessionId`, `createdAt`, `messageCount`, `lastMessageAt` are
 * server-managed and intentionally not patchable here.
 */
export const patchConversationHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const conversationId = pathParam(event, "conversationId");
  if (!conversationId) return json(event, 400, { error: "Missing conversationId path param" });

  const body = parseJsonBody(event);
  const patch: Parameters<typeof patchConversation>[2] = {};
  if (typeof body.title === "string") {
    const t = body.title.trim();
    if (!t) return json(event, 400, { error: "title cannot be empty" });
    patch.title = t.slice(0, 200);
  }
  if (typeof body.isArchived === "boolean") patch.isArchived = body.isArchived;
  if (typeof body.isPinned === "boolean") patch.isPinned = body.isPinned;
  if (Object.keys(patch).length === 0) {
    return json(event, 400, { error: "Nothing to patch. Allowed: title, isArchived, isPinned." });
  }

  const updated = await patchConversation(auth.userSub, conversationId, patch);
  if (!updated) return json(event, 404, { error: "Conversation not found" });
  return json(event, 200, updated);
};

/**
 * DELETE /chat/conversations/{conversationId}
 *
 * Cascade:
 *   1. Delete every ChatMessages row for this conversationId.
 *   2. Delete the ChatConversations row itself.
 *
 * AgentCore Memory namespace cleanup + Runtime session termination land in
 * WS-5/WS-6 (the runtime migration). For now the orphan memory records age
 * out at AgentCore's EventExpiryDuration (90 days).
 */
export const deleteConversationHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const conversationId = pathParam(event, "conversationId");
  if (!conversationId) return json(event, 400, { error: "Missing conversationId path param" });

  // Read first so we can return a clean 404 instead of silently no-op'ing
  // a stranger's id (composite-key delete on a non-owned row is a no-op).
  const existing = await getConversation(auth.userSub, conversationId);
  if (!existing) return json(event, 404, { error: "Conversation not found" });

  // Wipe transcript first — if the conversation row delete succeeds but
  // transcript wipe fails, we'd orphan rows. Doing it in this order means
  // a partial failure leaves a (degraded) conversation the user can retry.
  await clearChatMessagesByConversation(conversationId);
  await deleteConversation(auth.userSub, conversationId);

  return json(event, 200, { deleted: true, conversationId });
};

/**
 * GET /chat/conversations/{conversationId}/messages?limit=50&before=<ts>
 *
 * Per-conversation transcript reader. Replaces the old /chat/history
 * single-thread endpoint for new callers. Ownership check happens implicitly:
 * we 404 if the conversation row isn't owned by the caller before doing the
 * transcript Query, so a stranger's conversationId can't be enumerated.
 */
export const getConversationMessagesHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const conversationId = pathParam(event, "conversationId");
  if (!conversationId) return json(event, 400, { error: "Missing conversationId path param" });

  // Sandbox: only owners can read. Without this check, anyone with a
  // conversationId guess could read its messages (the transcript table has
  // no per-row owner check beyond the GSI partition).
  const conv = await getConversation(auth.userSub, conversationId);
  if (!conv) return json(event, 404, { error: "Conversation not found" });

  const qs = event.queryStringParameters || {};
  const limit = Math.max(1, Math.min(200, Number(qs.limit) || 50));
  const before = typeof qs.before === "string" && qs.before.length > 0 ? qs.before : undefined;

  const page = await listChatMessagesByConversation(conversationId, { limit, before });
  return json(event, 200, page);
};

/**
 * GET /chat/conversations/search?q=<term>&limit=20
 *
 * Phase-1 search: substring match on titles + recent-preview text, scored by
 * lastMessageAt recency. Implemented as a sidebar-bounded scan (caller's
 * own conversations only) so we don't pay scan cost on the whole table.
 *
 * Semantic search (OpenSearch Serverless) is intentionally deferred.
 */
export const searchConversationsHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const qs = event.queryStringParameters || {};
  const q = (typeof qs.q === "string" ? qs.q : "").trim().toLowerCase();
  const limit = Math.max(1, Math.min(50, Number(qs.limit) || 20));
  if (!q) return json(event, 200, { results: [] });

  // Walk the user's conversations (up to 500 rows) and filter in-memory.
  // For pro power users with thousands of conversations we'd switch to a
  // proper search backend; this is fine for the 99th percentile.
  const all: any[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = await listConversations(auth.userSub, { limit: 200, before: cursor, includeArchived: true });
    all.push(...page.conversations);
    cursor = page.nextBefore;
    pages++;
    if (pages > 5) break; // hard cap so a runaway query can't blow the Lambda budget
  } while (cursor && all.length < 1000);

  const matches = all
    .filter((c) => {
      const t = (c.title || "").toLowerCase();
      const p = (c.lastPreview || "").toLowerCase();
      return t.includes(q) || p.includes(q);
    })
    .slice(0, limit);
  return json(event, 200, { results: matches, total: matches.length });
};

/**
 * POST /chat/conversations/{conversationId}/regenerate-title
 *
 * Body: (optional) { title?: string }   ← if provided, use that verbatim
 *
 * If `title` is supplied, this is just a rename shortcut. If omitted, we
 * trigger the auto-title pipeline by summarising the first few transcript
 * turns via Haiku. The actual Haiku call is deferred to WS-5 (the chat
 * Lambda rewrite, which owns LLM access) — for now we accept the explicit
 * `title` form and 501 the auto path so the contract is established.
 */
export const regenerateTitleHandler = async (
  event: APIGatewayProxyEvent,
): Promise<APIGatewayProxyResult> => {
  const pre = preflight(event); if (pre) return pre;
  const auth = authenticate(event); if (isError(auth)) return auth;

  const conversationId = pathParam(event, "conversationId");
  if (!conversationId) return json(event, 400, { error: "Missing conversationId path param" });

  const body = parseJsonBody(event);
  if (typeof body.title === "string" && body.title.trim()) {
    const updated = await patchConversation(auth.userSub, conversationId, {
      title: body.title.trim().slice(0, 200),
    });
    if (!updated) return json(event, 404, { error: "Conversation not found" });
    return json(event, 200, updated);
  }

  // Auto-title path lands with the WS-5 chat Lambda rewrite. Until then,
  // surface 501 so frontend can fall back to manual rename.
  return json(event, 501, { error: "Auto-title generation not yet implemented; pass explicit { title } for now." });
};
