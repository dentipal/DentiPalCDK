/**
 * Persistent chat-transcript store for the user-facing chat history feature.
 *
 * Originally a single continuous thread per user; now scoped by
 * `conversationId` so the sidebar can render many distinct chats per user
 * (Claude.ai-style). Existing rows that pre-date the conversationId concept
 * get backfilled to a synthetic `legacy-<userSub>` id by the migration; the
 * GET /chat/history endpoint also falls back to that id when no conversation
 * is specified, so old callers keep working for one release.
 *
 * Table layout (DentiPal-V5-ChatMessages):
 *   HASH userSub : string         — Cognito user id
 *   RANGE ts    : string          — ISO-8601 ms (sorts lexicographically =
 *                                   chronologically), doubles as message id
 *
 *   GSI conversationId-ts-index:
 *     HASH conversationId
 *     RANGE ts
 *   → backs the per-conversation transcript reader (scroll up / load older).
 *
 *   Other fields: conversationId, sessionId, role ("USER" | "ASSISTANT"),
 *                 text, agentType.
 *
 * Distinct from AgentCore Memory:
 *   - AgentCore Memory holds compressed summaries + extracted preferences
 *     that the AI reads for cross-session grounding.
 *   - ChatMessages holds the verbatim transcript the *user* reads.
 *
 * Public sessions (anon-* userSubs) skip both — their userSub rotates per
 * connection so persistence would orphan rows immediately.
 *
 * All writes are tolerant: a failed PutItem logs and returns. The chat turn
 * is never blocked because the transcript log hiccuped.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";

const REGION = process.env.REGION || "us-east-1";
const CHAT_MESSAGES_TABLE = process.env.CHAT_MESSAGES_TABLE || "";
const CONVERSATION_ID_TS_INDEX = "conversationId-ts-index";

/**
 * Synthesize the conversationId used for transcript rows that pre-date the
 * conversation concept. The migration backfills existing rows with this same
 * value, and the GET /chat/history fallback resolves to it when no explicit
 * conversationId is provided. Single source of truth so both sides stay
 * aligned even if the convention changes.
 */
export function legacyConversationId(userSub: string): string {
  return `legacy-${userSub}`;
}

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export type ChatHistoryRole = "USER" | "ASSISTANT";

export interface ChatHistoryMessage {
  userSub: string;
  /** ISO-8601 ms timestamp; sorts lexicographically = chronologically. Doubles as the message id. */
  ts: string;
  /** Required. Scopes the row to one sidebar conversation. Pre-migration rows
   *  get `legacy-<userSub>` via the backfill; new writes must always pass an
   *  explicit value. */
  conversationId: string;
  sessionId: string;
  role: ChatHistoryRole;
  text: string;
  agentType?: "professional" | "clinic" | "public";
}

/**
 * Persist a single transcript row. Fire-and-forget at the call site —
 * never await on the user-visible path. Tolerant: logs on failure.
 */
export async function writeChatMessage(msg: ChatHistoryMessage): Promise<void> {
  if (!CHAT_MESSAGES_TABLE) return;
  if (!msg.text || !msg.text.trim()) return;
  try {
    await ddbDoc.send(new PutCommand({
      TableName: CHAT_MESSAGES_TABLE,
      Item: msg,
    }));
  } catch (e: any) {
    console.warn(`[chatHistory] writeChatMessage failed (userSub=${msg.userSub}, role=${msg.role}): ${e?.name || ""} ${e?.message || e}`);
  }
}

/**
 * Convenience: write a user turn and an assistant turn back-to-back with
 * timestamps 1ms apart (so ordering is unambiguous and both rows are
 * keyed under one logical "turn"). Fire-and-forget at the call site.
 *
 * `conversationId` is now required — caller (chatMessage Lambda) always
 * resolves it from the session row before invoking the agent.
 */
export async function writeTurn(opts: {
  userSub: string;
  conversationId: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  agentType?: "professional" | "clinic" | "public";
}): Promise<void> {
  const now = Date.now();
  const userTs = new Date(now).toISOString();
  const assistantTs = new Date(now + 1).toISOString();
  await Promise.all([
    writeChatMessage({
      userSub: opts.userSub,
      ts: userTs,
      conversationId: opts.conversationId,
      sessionId: opts.sessionId,
      role: "USER",
      text: opts.userText,
      agentType: opts.agentType,
    }),
    writeChatMessage({
      userSub: opts.userSub,
      ts: assistantTs,
      conversationId: opts.conversationId,
      sessionId: opts.sessionId,
      role: "ASSISTANT",
      text: opts.assistantText,
      agentType: opts.agentType,
    }),
  ]);
}

export interface ChatHistoryPage {
  /** Messages ordered DESCENDING by ts (newest first). The frontend reverses
   *  to display oldest-at-top. Newest-first matches the DynamoDB query and
   *  the "load older on scroll up" pagination shape. */
  messages: ChatHistoryMessage[];
  /** Pass to the next call's `before` to fetch the page older than this one.
   *  Absent => no more history. */
  nextBefore?: string;
}

/**
 * Whole-user transcript reader, kept for back-compat with the original
 * single-thread `GET /chat/history` contract. New code should prefer the
 * per-conversation variant below. Returns up to `limit` messages older
 * than `before` (exclusive). Default page size 50.
 */
export async function listChatMessages(
  userSub: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatHistoryPage> {
  if (!CHAT_MESSAGES_TABLE) return { messages: [] };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const params: Record<string, any> = {
    TableName: CHAT_MESSAGES_TABLE,
    KeyConditionExpression: opts.before
      ? "userSub = :u AND ts < :b"
      : "userSub = :u",
    ExpressionAttributeValues: opts.before
      ? { ":u": userSub, ":b": opts.before }
      : { ":u": userSub },
    ScanIndexForward: false, // descending — newest first
    Limit: limit,
  };

  try {
    const res = await ddbDoc.send(new QueryCommand(params as any));
    const messages = (res.Items || []) as ChatHistoryMessage[];
    // Only emit nextBefore if there's more to read — DDB sets LastEvaluatedKey
    // when its scan window hit Limit before exhausting, which is our signal.
    const nextBefore = res.LastEvaluatedKey
      ? messages[messages.length - 1]?.ts
      : undefined;
    return { messages, nextBefore };
  } catch (e: any) {
    console.warn(`[chatHistory] listChatMessages failed (userSub=${userSub}): ${e?.name || ""} ${e?.message || e}`);
    return { messages: [] };
  }
}

/**
 * Per-conversation transcript reader — the primary path for the new sidebar
 * UI. Queries the conversationId-ts-index GSI so a user with many
 * conversations doesn't pay scan cost reading just one of them.
 *
 * Behavior mirrors listChatMessages: newest-first, `before` cursor is the
 * `ts` of the last row on the previous page.
 */
export async function listChatMessagesByConversation(
  conversationId: string,
  opts: { limit?: number; before?: string } = {},
): Promise<ChatHistoryPage> {
  if (!CHAT_MESSAGES_TABLE) return { messages: [] };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  const params: Record<string, any> = {
    TableName: CHAT_MESSAGES_TABLE,
    IndexName: CONVERSATION_ID_TS_INDEX,
    KeyConditionExpression: opts.before
      ? "conversationId = :c AND ts < :b"
      : "conversationId = :c",
    ExpressionAttributeValues: opts.before
      ? { ":c": conversationId, ":b": opts.before }
      : { ":c": conversationId },
    ScanIndexForward: false,
    Limit: limit,
  };

  try {
    const res = await ddbDoc.send(new QueryCommand(params as any));
    const messages = (res.Items || []) as ChatHistoryMessage[];
    const nextBefore = res.LastEvaluatedKey
      ? messages[messages.length - 1]?.ts
      : undefined;
    return { messages, nextBefore };
  } catch (e: any) {
    console.warn(`[chatHistory] listChatMessagesByConversation failed (conversationId=${conversationId}): ${e?.name || ""} ${e?.message || e}`);
    return { messages: [] };
  }
}

/**
 * Wipe every transcript row for a user. Called from the account-deletion
 * flow so a closed account doesn't leave conversational artifacts behind.
 * Paginated with BatchWriteItem (max 25 keys per call).
 *
 * Idempotent — running twice is fine; running before any writes is also fine.
 */
export async function clearChatHistory(userSub: string): Promise<void> {
  if (!CHAT_MESSAGES_TABLE) return;
  try {
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await ddbDoc.send(new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        KeyConditionExpression: "userSub = :u",
        ExpressionAttributeValues: { ":u": userSub },
        ProjectionExpression: "userSub, ts",
        Limit: 100,
        ExclusiveStartKey: lastKey,
      } as any));
      const items = (page.Items || []) as Array<{ userSub: string; ts: string }>;
      // BatchWriteItem caps at 25 delete requests per call.
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await ddbDoc.send(new BatchWriteCommand({
          RequestItems: {
            [CHAT_MESSAGES_TABLE]: chunk.map((it) => ({
              DeleteRequest: { Key: { userSub: it.userSub, ts: it.ts } },
            })),
          },
        }));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  } catch (e: any) {
    console.warn(`[chatHistory] clearChatHistory failed (userSub=${userSub}): ${e?.name || ""} ${e?.message || e}`);
  }
}

/**
 * Wipe every transcript row belonging to a single conversation. Called from
 * the REST DELETE /chat/conversations/:id cascade so a deleted conversation
 * doesn't leave dangling messages behind.
 *
 * Pages via the conversationId-ts-index GSI to find rows, then BatchWriteItem
 * the base-table delete keys (which must include the BASE-table PK + SK, not
 * the GSI's PK — we project both via the GSI's ALL projection).
 *
 * Idempotent: running before any writes is fine, running twice is fine.
 */
export async function clearChatMessagesByConversation(conversationId: string): Promise<void> {
  if (!CHAT_MESSAGES_TABLE) return;
  try {
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await ddbDoc.send(new QueryCommand({
        TableName: CHAT_MESSAGES_TABLE,
        IndexName: CONVERSATION_ID_TS_INDEX,
        KeyConditionExpression: "conversationId = :c",
        ExpressionAttributeValues: { ":c": conversationId },
        // GSI ALL projection includes base-table key attrs, so userSub+ts
        // come back even though they aren't part of the GSI key.
        ProjectionExpression: "userSub, ts",
        Limit: 100,
        ExclusiveStartKey: lastKey,
      } as any));
      const items = (page.Items || []) as Array<{ userSub: string; ts: string }>;
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await ddbDoc.send(new BatchWriteCommand({
          RequestItems: {
            [CHAT_MESSAGES_TABLE]: chunk.map((it) => ({
              DeleteRequest: { Key: { userSub: it.userSub, ts: it.ts } },
            })),
          },
        }));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  } catch (e: any) {
    console.warn(`[chatHistory] clearChatMessagesByConversation failed (conversationId=${conversationId}): ${e?.name || ""} ${e?.message || e}`);
  }
}
