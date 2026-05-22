import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand, DeleteCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.REGION || "us-east-1";
const CHAT_CONNECTIONS_TABLE = process.env.CHAT_CONNECTIONS_TABLE || "DentiPal-V5-ChatConnections";
const CONNECTION_ID_INDEX = "connectionId-index";

const SESSION_TTL_SECONDS = 15 * 60; // 15 minutes

// `removeUndefinedValues: true` lets us write rows whose optional profile
// fields (firstName/lastName/specialties/home) are undefined without the
// marshaller rejecting them. Without this, fetchUserContext writes fail on
// any pro that hasn't filled in every optional profile field.
const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export type AgentType = "clinic" | "professional" | "public";

export interface ChatSession {
  userSub: string;
  connectionId: string;
  agentType: AgentType;
  bedrockSessionId: string;
  connectedAt: number;
  lastActivityAt: number;
  ttl: number;
  slotBuffer?: Record<string, any>;
  recentSearchResults?: any[];
  /** Cached user context (profile, address, clinics) fetched at bootstrap. */
  userContext?: Record<string, any>;
  /** Cognito groups the user belongs to, fetched at bootstrap via AdminGetUser.
   *  Source of truth for agent-type derivation and downstream RBAC checks
   *  (canWriteClinic etc.). Replaces the empty array we used to pass. */
  userGroups?: string[];
  /** Number of inbound user turns processed on this session. Incremented
   *  atomically by `refreshSession`. Public sessions are capped at 20 to
   *  bound Bedrock spend from drive-by abuse; authenticated sessions ignore
   *  it. Optional because pre-existing rows won't have the field. */
  messageCount?: number;
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Called from $connect. Writes a fresh row keyed by (userSub, connectionId).
 * For unauthenticated public-agent connections the caller supplies a synthetic
 * userSub like `anon-<uuid>` so the same key shape works for everyone.
 */
export async function createSessionForConnection(
  userSub: string,
  connectionId: string,
  agentType: AgentType
): Promise<ChatSession> {
  const now = nowSec();
  const session: ChatSession = {
    userSub,
    connectionId,
    agentType,
    bedrockSessionId: uuidv4(),
    connectedAt: now,
    lastActivityAt: now,
    ttl: now + SESSION_TTL_SECONDS,
  };
  await ddb.send(new PutCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Item: session,
  }));
  return session;
}

/**
 * Direct lookup when chatMessage knows both keys (it does, after the first
 * $connect → we cache userSub on the websocket context in the route handler
 * via the connection record).
 */
export async function getSessionByCompositeKey(
  userSub: string,
  connectionId: string
): Promise<ChatSession | null> {
  const res = await ddb.send(new GetCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
  }));
  if (!res.Item) return null;
  const session = res.Item as ChatSession;
  if (session.ttl && session.ttl < nowSec()) return null;
  return session;
}

/**
 * Reverse lookup by connectionId only. Used by $disconnect (API Gateway gives
 * us only the connectionId) and by chatMessage when the route integration
 * doesn't carry userSub through the context. Uses the connectionId-index GSI
 * so it's a single-shot query, not a table scan.
 */
export async function getSessionByConnectionId(connectionId: string): Promise<ChatSession | null> {
  const res = await ddb.send(new QueryCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    IndexName: CONNECTION_ID_INDEX,
    KeyConditionExpression: "connectionId = :cid",
    ExpressionAttributeValues: { ":cid": connectionId },
    Limit: 1,
  }));
  const item = res.Items?.[0];
  if (!item) return null;
  const session = item as ChatSession;
  if (session.ttl && session.ttl < nowSec()) return null;
  return session;
}

/**
 * Refresh the 15-min TTL on each turn so the session stays alive while
 * active. Also atomically increments `messageCount` and returns the new
 * value — public sessions read this to enforce a per-session cap (see
 * chatMessage.ts). For authenticated sessions the counter still increments
 * but the caller is free to ignore the return value.
 *
 * Returns `null` if the row was already expired (Conditional check failed)
 * — caller should re-bootstrap.
 */
export async function refreshSession(userSub: string, connectionId: string): Promise<number | null> {
  const now = nowSec();
  try {
    const res = await ddb.send(new UpdateCommand({
      TableName: CHAT_CONNECTIONS_TABLE,
      Key: { userSub, connectionId },
      UpdateExpression: "SET lastActivityAt = :now, #ttl = :ttl ADD messageCount :one",
      ExpressionAttributeNames: { "#ttl": "ttl" },
      ExpressionAttributeValues: { ":now": now, ":ttl": now + SESSION_TTL_SECONDS, ":one": 1 },
      // Don't refresh expired rows — let DDB GC them.
      ConditionExpression: "attribute_not_exists(#ttl) OR #ttl > :now",
      ReturnValues: "UPDATED_NEW",
    }));
    const newCount = res.Attributes?.messageCount;
    return typeof newCount === "number" ? newCount : null;
  } catch (e: any) {
    // ConditionalCheckFailedException — row expired or doesn't exist.
    if (e?.name === "ConditionalCheckFailedException") return null;
    throw e;
  }
}

/** Called from $disconnect. Idempotent — DDB TTL will clean it up anyway within 15 min. */
export async function deleteSession(userSub: string, connectionId: string): Promise<void> {
  await ddb.send(new DeleteCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
  }));
}

/** Merge fields into slotBuffer (in-progress form payload). */
export async function updateSlotBuffer(
  userSub: string,
  connectionId: string,
  slotPatch: Record<string, any>
): Promise<void> {
  const existing = await getSessionByCompositeKey(userSub, connectionId);
  if (!existing) throw new Error("Session not found or expired");
  const merged = { ...(existing.slotBuffer || {}), ...slotPatch };
  const now = nowSec();
  await ddb.send(new UpdateCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
    UpdateExpression: "SET slotBuffer = :sb, lastActivityAt = :now, #ttl = :ttl",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":sb": merged,
      ":now": now,
      ":ttl": now + SESSION_TTL_SECONDS,
    },
  }));
}

/** Persist the latest search results so the LLM can resolve "the third one" references. */
export async function setRecentSearchResults(
  userSub: string,
  connectionId: string,
  results: any[]
): Promise<void> {
  const now = nowSec();
  await ddb.send(new UpdateCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
    UpdateExpression: "SET recentSearchResults = :r, lastActivityAt = :now, #ttl = :ttl",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":r": results,
      ":now": now,
      ":ttl": now + SESSION_TTL_SECONDS,
    },
  }));
}

/** Cache fetched user context (profile + address + clinics) on the session row. */
export async function setUserContext(
  userSub: string,
  connectionId: string,
  userContext: Record<string, any>,
): Promise<void> {
  const now = nowSec();
  await ddb.send(new UpdateCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
    UpdateExpression: "SET userContext = :ctx, lastActivityAt = :now, #ttl = :ttl",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":ctx": userContext,
      ":now": now,
      ":ttl": now + SESSION_TTL_SECONDS,
    },
  }));
}

/** Cache the user's Cognito groups + canonical agent type on the session. */
export async function setUserGroupsAndAgentType(
  userSub: string,
  connectionId: string,
  userGroups: string[],
  agentType: AgentType,
): Promise<void> {
  const now = nowSec();
  await ddb.send(new UpdateCommand({
    TableName: CHAT_CONNECTIONS_TABLE,
    Key: { userSub, connectionId },
    UpdateExpression: "SET userGroups = :g, agentType = :a, lastActivityAt = :now, #ttl = :ttl",
    ExpressionAttributeNames: { "#ttl": "ttl" },
    ExpressionAttributeValues: {
      ":g": userGroups,
      ":a": agentType,
      ":now": now,
      ":ttl": now + SESSION_TTL_SECONDS,
    },
  }));
}

