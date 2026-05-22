/**
 * DDB access layer for the PreviewGates table.
 *
 * One row per outstanding `preview_*` tool call. The matching `confirm_*`
 * call looks the row up, verifies token + payload + age, then deletes it.
 * DDB TTL evicts forgotten rows after 5 minutes (same window as the
 * previous in-session gate, see MAX_PREVIEW_AGE_SEC in previewGate.ts).
 *
 * Table layout (DentiPal-V5-PreviewGates):
 *   HASH userSub      : string
 *   RANGE previewToken: string (UUID minted at preview time)
 *   ttl  : number (epoch seconds — DDB TTL deletes the row when reached)
 *
 *   Other fields: toolName, payload (JSON), conversationId (optional —
 *                 populated post-WS-5 so we can attribute confirms to a
 *                 specific conversation), createdAt (ISO ms).
 *
 * Why this exists separately from ChatConnections.pendingPreview:
 *   - Confirm path must work even when the chat session has expired or
 *     migrated (AgentCore Runtime sessions can outlive a WebSocket).
 *   - Multiple concurrent previews in one session work cleanly (no
 *     single-slot collision on the connection row).
 *   - TTL is per-row, not coupled to session TTL.
 */

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import { v4 as uuidv4 } from "uuid";

const REGION = process.env.REGION || "us-east-1";
const PREVIEW_GATES_TABLE = process.env.PREVIEW_GATES_TABLE || "";

/** 5-minute window matches the old in-session gate. Long enough for a user
 *  to read a confirm card and click; short enough that an abandoned preview
 *  can't be replayed days later. */
export const PREVIEW_TTL_SECONDS = 5 * 60;

const ddb = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: REGION }),
  { marshallOptions: { removeUndefinedValues: true } },
);

export interface PreviewGateRow {
  userSub: string;
  previewToken: string;
  toolName: string;
  payload: Record<string, any>;
  conversationId?: string;
  createdAt: number; // epoch seconds
  ttl: number;       // epoch seconds — DDB TTL deletes when reached
}

const nowSec = (): number => Math.floor(Date.now() / 1000);

/**
 * Persist a fresh preview row and return its newly-minted previewToken.
 * Caller (genericPreview in toolExecutor) bakes the token into the
 * confirm-card payload so the widget can echo it back on confirm.
 */
export async function putPreview(opts: {
  userSub: string;
  toolName: string;
  payload: Record<string, any>;
  conversationId?: string;
}): Promise<string> {
  if (!PREVIEW_GATES_TABLE) throw new Error("PREVIEW_GATES_TABLE not configured");

  const previewToken = uuidv4();
  const now = nowSec();
  const row: PreviewGateRow = {
    userSub: opts.userSub,
    previewToken,
    toolName: opts.toolName,
    payload: opts.payload,
    conversationId: opts.conversationId,
    createdAt: now,
    ttl: now + PREVIEW_TTL_SECONDS,
  };
  await ddb.send(new PutCommand({
    TableName: PREVIEW_GATES_TABLE,
    Item: row,
  }));
  return previewToken;
}

/**
 * Single-row read. Returns null if the row doesn't exist OR if its TTL has
 * passed (DDB TTL deletion is best-effort with up-to-48h lag, so we
 * double-check here on read). Caller (previewGate) treats null as "no
 * pending preview" — the same error path the old gate took.
 */
export async function getPreview(
  userSub: string,
  previewToken: string,
): Promise<PreviewGateRow | null> {
  if (!PREVIEW_GATES_TABLE) return null;
  const res = await ddb.send(new GetCommand({
    TableName: PREVIEW_GATES_TABLE,
    Key: { userSub, previewToken },
  }));
  const row = (res.Item as PreviewGateRow) || null;
  if (!row) return null;
  if (row.ttl && row.ttl < nowSec()) return null;
  return row;
}

/**
 * Delete the row after a successful confirm. Confirms are one-shot: once
 * burned, a token can't be replayed. The row would also age out via TTL
 * but we drop it eagerly so a paranoid replay-then-tamper can't even try.
 *
 * Idempotent — running twice or against a missing row is a no-op.
 */
export async function deletePreview(
  userSub: string,
  previewToken: string,
): Promise<void> {
  if (!PREVIEW_GATES_TABLE) return;
  await ddb.send(new DeleteCommand({
    TableName: PREVIEW_GATES_TABLE,
    Key: { userSub, previewToken },
  }));
}
