/**
 * AgentCore Memory I/O helpers.
 *
 * Wraps the @aws-sdk/client-bedrock-agentcore data plane for the chat
 * Lambda's needs:
 *  - Write turns as conversational events so the managed SUMMARIZATION
 *    and USER_PREFERENCE strategies extract long-term records in the
 *    background.
 *  - Retrieve those records on session bootstrap and inject them into
 *    the first-turn preamble so the user perceives continuity across days.
 *  
 *
 *
 * All three helpers are tolerant: if AgentCore is unreachable or the memory
 * isn't provisioned yet, they log and return a neutral value rather than
 * blocking the chat turn. Memory is a quality-of-life signal, not load-bearing.
 */

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
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
 * Fetch a compact, prompt-injection-ready text block summarising what
 * AgentCore Memory has on this user across prior sessions. Returns the
 * empty string if no records exist (cold start, AgentCore unreachable,
 * memory not yet provisioned, async extraction hasn't run yet).
 *
 * Caller is responsible for deciding whether to inject it into the
 * preamble — typically only on the first turn of a new chat session.
 */
export async function hydrateMemoryPreamble(userSub: string): Promise<string> {
  if (!MEMORY_ID) return "";

  // Two semantic-search calls in parallel: one for prior session
  // summaries, one for extracted preferences. namespacePath uses the
  // hierarchical prefix so we match across all sessions for this user.
  const [summaries, preferences] = await Promise.all([
    retrieveRecordsSafe(`/summaries/${userSub}/`, "Most recent and relevant prior conversation context with this user."),
    retrieveRecordsSafe(`/preferences/${userSub}/`, "Stable user preferences, goals, and constraints."),
  ]);

  if (!summaries.length && !preferences.length) return "";

  const lines: string[] = [
    `[USER MEMORY — extracted from prior conversations with this user; treat as context, do not echo verbatim]`,
  ];
  if (preferences.length) {
    lines.push(`preferences:`);
    for (const p of preferences) lines.push(`  - ${p}`);
  }
  if (summaries.length) {
    lines.push(`recent session summaries:`);
    for (const s of summaries) lines.push(`  - ${s}`);
  }
  lines.push(`[END USER MEMORY]`);
  return lines.join("\n");
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

async function retrieveRecordsSafe(
  namespacePath: string,
  searchQuery: string,
): Promise<string[]> {
  try {
    const res = await client.send(new RetrieveMemoryRecordsCommand({
      memoryId: MEMORY_ID,
      namespacePath,
      searchCriteria: {
        searchQuery,
        topK: 5,
      },
    }));
    const summaries = res.memoryRecordSummaries || [];
    return summaries
      .map((r: any) => extractRecordText(r))
      .filter((s): s is string => !!s && s.length > 0);
  } catch (e: any) {
    // Empty namespace returns AccessDenied or ResourceNotFound on some
    // accounts when no records exist yet — treat as cold start.
    const name = e?.name || "";
    if (name === "ResourceNotFoundException" || name === "AccessDeniedException") return [];
    console.warn(`[agentCoreMemory] retrieve namespacePath=${namespacePath} failed: ${name} ${e?.message || e}`);
    return [];
  }
}

/** Pull a usable text string out of a MemoryRecordSummary. */
function extractRecordText(record: any): string | undefined {
  // Strategies may return content in different shapes:
  //   - SUMMARIZATION → { content: { text: "..." } }
  //   - USER_PREFERENCE → may be a structured JSON payload like
  //     { content: { json: { ... } } } or stringified JSON
  //   - some SDK versions surface a top-level `text` field
  // Probe each shape and serialize JSON to a compact one-liner so the
  // preamble stays prompt-friendly. Collapse whitespace either way.
  const c = record?.content;
  let text: string | undefined;
  if (typeof c?.text === "string") {
    text = c.text;
  } else if (typeof record?.text === "string") {
    text = record.text;
  } else if (c?.json !== undefined) {
    try { text = JSON.stringify(c.json); } catch { /* drop */ }
  } else if (typeof c === "object" && c !== null) {
    try { text = JSON.stringify(c); } catch { /* drop */ }
  }
  if (typeof text !== "string" || !text.trim()) return undefined;
  return text.replace(/\s+/g, " ").trim();
}

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
