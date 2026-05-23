/**
 * DDB access layer for the chatbot Conversations table.
 *
 * One row per chatbot conversation per user. A "conversation" is a long-lived
 * thread the user can return to later — the model for the Claude.ai-style
 * sidebar. Each conversation owns a transcript (in ChatMessages, filtered by
 * conversationId) and, once Phase-1 of the AgentCore Runtime migration lands,
 * one runtimeSessionId that lets the agent resume mid-plan across days.
 *
 * Table layout (DentiPal-V5-ChatConversations):
 *   HASH userSub         : string
 *   RANGE conversationId : string (UUID)
 *
 *   GSI userSub-lastMessageAt-index:
 *     HASH userSub
 *     RANGE lastMessageAt (ISO-8601 ms)
 *   → backs the sidebar list ordering and "load older" pagination.
 *
 *   Other fields: title, agentRoute, runtimeSessionId, createdAt,
 *                 lastPreview, messageCount, isArchived, isPinned.
 *
 * Distinct from the user-to-user DentiPal-V5-Conversations table — that table
 * holds clinic↔professional messaging threads and uses an entirely different
 * key shape. Naming them apart (Chat* prefix) keeps the two from being
 * confused.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.REGION || "us-east-1";
const CHAT_CONVERSATIONS_TABLE = process.env.CHAT_CONVERSATIONS_TABLE || "";
const LAST_MESSAGE_AT_INDEX = "userSub-lastMessageAt-index";

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export type AgentRoute = "professional" | "clinic" | "public";

export interface ChatConversation {
  userSub: string;
  conversationId: string;
  title: string;
  agentRoute: AgentRoute;
  /** Mintage of this conversation's AgentCore Runtime session. Null until the
   *  first chatMessage frame is sent — the WS handler patches it then so
   *  subsequent turns resume the same runtime session. */
  runtimeSessionId?: string;
  createdAt: string;
  lastMessageAt: string;
  /** Snippet of the most recent user OR assistant turn, used by the sidebar
   *  to render a one-line preview. Truncated to 200 chars on write. */
  lastPreview?: string;
  messageCount: number;
  isArchived?: boolean;
  isPinned?: boolean;
}

const PREVIEW_MAX_LEN = 200;

const nowIso = (): string => new Date().toISOString();

function trimPreview(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > PREVIEW_MAX_LEN ? t.slice(0, PREVIEW_MAX_LEN - 1) + "…" : t;
}

/**
 * Mint a new conversation. Caller supplies the agentRoute (derived from
 * Cognito groups by the REST handler). `title` defaults to "New chat" and is
 * auto-rewritten by the chat Lambda after the first assistant turn — see the
 * regenerate-title endpoint.
 *
 * Returns the freshly-written row, including the new conversationId.
 */
export async function createConversation(opts: {
  userSub: string;
  agentRoute: AgentRoute;
  title?: string;
}): Promise<ChatConversation> {
  if (!CHAT_CONVERSATIONS_TABLE) throw new Error("CHAT_CONVERSATIONS_TABLE not configured");

  const now = nowIso();
  const conv: ChatConversation = {
    userSub: opts.userSub,
    conversationId: uuidv4(),
    title: opts.title?.trim() || "New chat",
    agentRoute: opts.agentRoute,
    createdAt: now,
    lastMessageAt: now,
    messageCount: 0,
  };
  await ddb.send(new PutCommand({
    TableName: CHAT_CONVERSATIONS_TABLE,
    Item: conv,
  }));
  return conv;
}

/** Single-row read by composite key. Returns null if not found. */
export async function getConversation(
  userSub: string,
  conversationId: string,
): Promise<ChatConversation | null> {
  if (!CHAT_CONVERSATIONS_TABLE) return null;
  const res = await ddb.send(new GetCommand({
    TableName: CHAT_CONVERSATIONS_TABLE,
    Key: { userSub, conversationId },
  }));
  return (res.Item as ChatConversation) || null;
}

export interface ListConversationsPage {
  conversations: ChatConversation[];
  /** Cursor for the next (older) page. Absent => exhausted. */
  nextBefore?: string;
}

/**
 * Paginated sidebar list, newest-first by `lastMessageAt`. Uses the
 * `userSub-lastMessageAt-index` GSI so the table doesn't need to be scanned.
 *
 * `before` is the lastMessageAt of the last item on the previous page —
 * pass it back to fetch the next (older) chunk.
 *
 * `includeArchived` defaults to false; the sidebar can opt in to show
 * archived conversations under an "Archived" section.
 */
export async function listConversations(
  userSub: string,
  opts: { limit?: number; before?: string; includeArchived?: boolean } = {},
): Promise<ListConversationsPage> {
  if (!CHAT_CONVERSATIONS_TABLE) return { conversations: [] };
  const limit = Math.max(1, Math.min(200, opts.limit ?? 50));

  // KCE uses ts < :b when paginating; without pagination just PK = :u.
  // Filter happens server-side via FilterExpression so the GSI still scans
  // efficiently and we keep the page size honest.
  const params: Record<string, any> = {
    TableName: CHAT_CONVERSATIONS_TABLE,
    IndexName: LAST_MESSAGE_AT_INDEX,
    KeyConditionExpression: opts.before
      ? "userSub = :u AND lastMessageAt < :b"
      : "userSub = :u",
    ExpressionAttributeValues: opts.before
      ? { ":u": userSub, ":b": opts.before }
      : { ":u": userSub },
    ScanIndexForward: false,
    Limit: limit,
  };

  if (!opts.includeArchived) {
    params.FilterExpression = "attribute_not_exists(isArchived) OR isArchived = :false";
    params.ExpressionAttributeValues = { ...params.ExpressionAttributeValues, ":false": false };
  }

  try {
    const res = await ddb.send(new QueryCommand(params as any));
    const items = (res.Items || []) as ChatConversation[];
    // Only emit nextBefore if the underlying scan stopped due to Limit,
    // mirroring the chatHistoryStore pagination contract.
    const nextBefore = res.LastEvaluatedKey
      ? items[items.length - 1]?.lastMessageAt
      : undefined;
    return { conversations: items, nextBefore };
  } catch (e: any) {
    console.warn(`[chatConvos] list failed (userSub=${userSub}): ${e?.name || ""} ${e?.message || e}`);
    return { conversations: [] };
  }
}

export interface UpdateConversationPatch {
  title?: string;
  isArchived?: boolean;
  isPinned?: boolean;
  /** Set by the chat WS Lambda the first time a conversation is invoked —
   *  pins the AgentCore Runtime session for resume. */
  runtimeSessionId?: string;
}

/**
 * Partial update. Only the listed fields are written. `lastMessageAt` is
 * NOT bumped here — use `touchConversation` for that, called from the
 * transcript-write path.
 *
 * Returns the updated row.
 */
export async function patchConversation(
  userSub: string,
  conversationId: string,
  patch: UpdateConversationPatch,
): Promise<ChatConversation | null> {
  if (!CHAT_CONVERSATIONS_TABLE) return null;

  const setParts: string[] = [];
  const attrNames: Record<string, string> = {};
  const attrValues: Record<string, any> = {};
  let i = 0;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    const nameTok = `#k${i}`;
    const valTok = `:v${i}`;
    attrNames[nameTok] = k;
    attrValues[valTok] = v;
    setParts.push(`${nameTok} = ${valTok}`);
    i++;
  }
  if (setParts.length === 0) return getConversation(userSub, conversationId);

  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: CHAT_CONVERSATIONS_TABLE,
      Key: { userSub, conversationId },
      UpdateExpression: `SET ${setParts.join(", ")}`,
      ExpressionAttributeNames: attrNames,
      ExpressionAttributeValues: attrValues,
      // Reject patches against a non-existent row so the REST handler can
      // turn it into a 404 (instead of silently creating a phantom row).
      ConditionExpression: "attribute_exists(conversationId)",
      ReturnValues: "ALL_NEW",
    }));
    return (res.Attributes as ChatConversation) || null;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return null;
    throw e;
  }
}

/**
 * Bump `lastMessageAt` + increment `messageCount` + update `lastPreview`.
 * Called from the chat transcript-write path on every turn. Cheap update,
 * keeps the sidebar's "newest first" order honest.
 *
 * Returns the new messageCount (caller is free to ignore).
 */
export async function touchConversation(
  userSub: string,
  conversationId: string,
  opts: { preview?: string } = {},
): Promise<number | null> {
  if (!CHAT_CONVERSATIONS_TABLE) return null;
  const now = nowIso();
  const preview = trimPreview(opts.preview);
  const setExpr = preview
    ? "SET lastMessageAt = :now, lastPreview = :p"
    : "SET lastMessageAt = :now";
  const attrValues: Record<string, any> = { ":now": now, ":one": 1 };
  if (preview) attrValues[":p"] = preview;
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: CHAT_CONVERSATIONS_TABLE,
      Key: { userSub, conversationId },
      UpdateExpression: `${setExpr} ADD messageCount :one`,
      ExpressionAttributeValues: attrValues,
      ConditionExpression: "attribute_exists(conversationId)",
      ReturnValues: "UPDATED_NEW",
    }));
    const newCount = res.Attributes?.messageCount;
    return typeof newCount === "number" ? newCount : null;
  } catch (e: any) {
    if (e?.name === "ConditionalCheckFailedException") return null;
    throw e;
  }
}

/**
 * Delete one conversation row. Does NOT cascade to ChatMessages or AgentCore
 * Memory — the caller (REST DELETE handler) is responsible for that fan-out.
 * Keeping the cascade out of this function lets unit tests target just the
 * row delete.
 */
export async function deleteConversation(
  userSub: string,
  conversationId: string,
): Promise<void> {
  if (!CHAT_CONVERSATIONS_TABLE) return;
  await ddb.send(new DeleteCommand({
    TableName: CHAT_CONVERSATIONS_TABLE,
    Key: { userSub, conversationId },
  }));
}

/**
 * Wipe every conversation row for a user. Called from the account-deletion
 * cascade (alongside clearChatHistory + clearUserMemory). BatchWrite caps at
 * 25 keys per call, so we page.
 *
 * Like deleteConversation, this does NOT touch the transcript rows or
 * AgentCore Memory — the account-deletion handler invokes those separately.
 */
export async function clearAllConversations(userSub: string): Promise<void> {
  if (!CHAT_CONVERSATIONS_TABLE) return;
  try {
    let lastKey: Record<string, any> | undefined;
    do {
      const page = await ddb.send(new QueryCommand({
        TableName: CHAT_CONVERSATIONS_TABLE,
        KeyConditionExpression: "userSub = :u",
        ExpressionAttributeValues: { ":u": userSub },
        ProjectionExpression: "userSub, conversationId",
        Limit: 100,
        ExclusiveStartKey: lastKey,
      } as any));
      const items = (page.Items || []) as Array<{ userSub: string; conversationId: string }>;
      for (let i = 0; i < items.length; i += 25) {
        const chunk = items.slice(i, i + 25);
        await ddb.send(new BatchWriteCommand({
          RequestItems: {
            [CHAT_CONVERSATIONS_TABLE]: chunk.map((it) => ({
              DeleteRequest: { Key: { userSub: it.userSub, conversationId: it.conversationId } },
            })),
          },
        }));
      }
      lastKey = page.LastEvaluatedKey;
    } while (lastKey);
  } catch (e: any) {
    console.warn(`[chatConvos] clear failed (userSub=${userSub}): ${e?.name || ""} ${e?.message || e}`);
  }
}
