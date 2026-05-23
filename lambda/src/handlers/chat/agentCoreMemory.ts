/**
 * AgentCore Memory I/O helpers for the chat Lambda.
 *
 * Two responsibilities remain after the AgentCore Runtime migration:
 *  - `writeMemoryEvent`: persist turns from chatMessage's confirmAction
 *    shortcut (the WS-bypass path that runs confirm_* tools directly).
 *    Regular chat turns now flow through the runtime container, which
 *    writes its own memory via runtime/shared/memory.ts.
 *  - `clearUserMemory`: cascade-delete a user's derived memory records
 *    on account deletion (deleteOwnAccount.ts).
 *
 * Retrieval / preamble assembly moved into the runtime container — this
 * Lambda no longer reads memory. All operations here are tolerant: if
 * AgentCore is unreachable or the memory isn't provisioned yet, they
 * log and return rather than blocking the chat turn.
 */

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  ListMemoryRecordsCommand,
  BatchDeleteMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env.REGION || "us-east-1";
const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || "";

const client = new BedrockAgentCoreClient({ region: REGION });

/** Roles AgentCore Memory accepts on a conversational payload. */
type ConversationalRole = "USER" | "ASSISTANT" | "TOOL" | "OTHER";

export interface ConversationTurn {
  role: ConversationalRole;
  text: string;
}

/**
 * Append a multi-turn conversation event to AgentCore Memory under
 * (actorId=userSub, sessionId). The managed strategies bound to the memory
 * pick it up asynchronously and produce summary / preference records under
 * the configured namespace templates.
 *
 * Never throws — logs and returns. A failed memory write must not surface
 * to the end user as a chat failure.
 */
export async function writeMemoryEvent(
  userSub: string,
  sessionId: string,
  turns: ConversationTurn[],
): Promise<void> {
  if (!MEMORY_ID) return;
  if (!turns.length) return;

  try {
    await client.send(new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: userSub,
      sessionId,
      eventTimestamp: new Date(),
      payload: turns.map((t) => ({
        conversational: {
          content: { text: t.text },
          role: t.role,
        },
      })),
    }));
  } catch (e: any) {
    console.warn(`[agentCoreMemory] writeMemoryEvent failed for actor=${userSub}: ${e?.name || ""} ${e?.message || e}`);
  }
}

/**
 * Delete every derived memory record (summaries + preferences) for a given
 * user. Called from the account-deletion path so a closed account doesn't
 * leave conversational artifacts behind.
 *
 * NOTE: We only delete derived records, not the raw events that produced
 * them. `ListEventsCommand` requires (memoryId, actorId, sessionId) and we
 * don't keep a per-user index of historical sessionIds — enumeration isn't
 * possible from our side. Raw events expire naturally at
 * `EventExpiryDuration` (90 days) and become inert once the derived records
 * are gone. From the user's perspective the agent forgets them immediately;
 * raw events linger only in AgentCore's internal storage, are not retrieved
 * by our retrieval calls, and self-expire.
 *
 * Idempotent — running twice is fine; running before any memory has
 * been written is also fine.
 */
export async function clearUserMemory(userSub: string): Promise<void> {
  if (!MEMORY_ID) return;

  try {
    await Promise.all([
      deleteRecordsUnderNamespacePath(`/summaries/${userSub}/`),
      deleteRecordsUnderNamespacePath(`/preferences/${userSub}/`),
    ]);
  } catch (e: any) {
    console.warn(`[agentCoreMemory] clearUserMemory partially failed for actor=${userSub}: ${e?.name || ""} ${e?.message || e}`);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────

async function deleteRecordsUnderNamespacePath(namespacePath: string): Promise<void> {
  let nextToken: string | undefined = undefined;
  do {
    // `: any` on the response sidesteps a TS circular-inference complaint
    // when the loop variable `nextToken` is reassigned from `res.nextToken`.
    // SDK field names are still verified against schemas_0.js.
    const res: any = await client.send(new ListMemoryRecordsCommand({
      memoryId: MEMORY_ID,
      namespacePath,
      maxResults: 100,
      nextToken,
    }));
    const ids: string[] = (res?.memoryRecordSummaries || [])
      .map((r: any) => r?.memoryRecordId)
      .filter((id: any): id is string => typeof id === "string");
    if (ids.length) {
      // SDK field is `records`, not `memoryRecords` (verified against
      // BatchDeleteMemoryRecordsInput$ in schemas_0.js: fields = [memoryId, records]).
      await client.send(new BatchDeleteMemoryRecordsCommand({
        memoryId: MEMORY_ID,
        records: ids.map((id) => ({ memoryRecordId: id })),
      }));
    }
    nextToken = res?.nextToken;
  } while (nextToken);
}
