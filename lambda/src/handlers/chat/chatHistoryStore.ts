/**
 * Persistent chat-transcript store for the user-facing "scroll up to see
 * previous chats" feature. Single continuous thread per user.
 *
 * Table layout (DentiPal-V5-ChatMessages):
 *   HASH userSub : string         — Cognito user id
 *   RANGE ts    : string          — ISO-8601 ms (sorts lexicographically =
 *                                   chronologically), doubles as message id
 *
 *   Other fields: sessionId, role ("USER" | "ASSISTANT"), text, agentType.
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

const ddbDoc = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export type ChatHistoryRole = "USER" | "ASSISTANT";

export interface ChatHistoryMessage {
  userSub: string;
  /** ISO-8601 ms timestamp; sorts lexicographically = chronologically. Doubles as the message id. */
  ts: string;
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
 */
export async function writeTurn(opts: {
  userSub: string;
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
      sessionId: opts.sessionId,
      role: "USER",
      text: opts.userText,
      agentType: opts.agentType,
    }),
    writeChatMessage({
      userSub: opts.userSub,
      ts: assistantTs,
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
 * Read the user's transcript in pages. Returns up to `limit` messages newer
 * than `before` (exclusive). Default page size 50.
 *
 * Used by the GET /chat/history REST endpoint.
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
