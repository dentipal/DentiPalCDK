/**
 * AgentCore Memory hydrate + write for the runtime agents.
 *
 * 3-tier mental model the runtime carries:
 *   - Working  : LangGraph state in the current invocation. Persisted by
 *                AgentCore Runtime's session store keyed by runtimeSessionId.
 *                Not touched by this module.
 *   - Episodic : SUMMARIZATION strategy in AgentCore Memory, namespace
 *                /summaries/{actorId}/{sessionId}/. Rolling per-session
 *                summary. We pass the conversationId as sessionId so the
 *                summaries scope per conversation, not per chat session.
 *   - Semantic : USER_PREFERENCE strategy in AgentCore Memory, namespace
 *                /preferences/{actorId}/. Extracted stable preferences
 *                across all conversations.
 *
 * Strategies stay UNCHANGED from the pre-WS-6 state — we hydrate and write
 * against the existing namespaces so legacy memory records (from the
 * Bedrock Agents era) continue to surface here. A future deploy can add
 * a CUSTOM strategy for structured facts; the hydrate code below is the
 * one place that would change.
 */

import {
  BedrockAgentCoreClient,
  CreateEventCommand,
  RetrieveMemoryRecordsCommand,
} from "@aws-sdk/client-bedrock-agentcore";

const REGION = process.env.AWS_REGION || "us-east-1";
const MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || "";

const client = new BedrockAgentCoreClient({ region: REGION });

type ConversationalRole = "USER" | "ASSISTANT" | "TOOL" | "OTHER";

export interface ConversationTurn {
  role: ConversationalRole;
  text: string;
}

export interface HydratedMemory {
  /** Compact text block ready to prepend to the system prompt — pre-formatted
   *  by combining episodic summaries + semantic preferences. Empty string
   *  when no records exist OR AgentCore is unreachable. */
  preamble: string;
  /** Raw retrieved records (for debugging / future structured use). */
  summaries: string[];
  preferences: string[];
}

const EMPTY: HydratedMemory = { preamble: "", summaries: [], preferences: [] };

/**
 * Pull episodic + semantic records for this user and assemble a preamble.
 * Called once per agent invocation (the LangGraph plan node) so the LLM
 * sees prior-session context on its very first model call.
 *
 * Tolerant: any failure (missing env, unreachable AgentCore, namespace not
 * yet populated) → returns empty. The agent still works without memory.
 *
 * Note on the timeout: AgentCore Memory's RetrieveMemoryRecords can be slow
 * during cold periods. We race against 1.5s per call so a hanging memory
 * lookup doesn't block the user's first token. Same threshold the legacy
 * chatMessage.ts used before WS-5.
 */
export async function hydrateMemory(opts: {
  userSub: string;
  conversationId: string;
}): Promise<HydratedMemory> {
  if (!MEMORY_ID || !opts.userSub) return EMPTY;

  // Episodic: scoped to THIS conversation (the most relevant context).
  // Semantic: across all conversations for the user.
  const [summaries, preferences] = await Promise.all([
    retrieveRecordsSafe(
      `/summaries/${opts.userSub}/`,
      "Most recent and relevant prior conversation context with this user.",
    ),
    retrieveRecordsSafe(
      `/preferences/${opts.userSub}/`,
      "Stable user preferences, goals, and constraints.",
    ),
  ]);

  if (!summaries.length && !preferences.length) return EMPTY;

  const lines: string[] = [
    `[USER MEMORY — extracted from prior conversations with this user; treat as context, do not echo verbatim]`,
  ];
  if (preferences.length) {
    lines.push("preferences:");
    for (const p of preferences) lines.push(`  - ${p}`);
  }
  if (summaries.length) {
    lines.push("recent session summaries:");
    for (const s of summaries) lines.push(`  - ${s}`);
  }
  lines.push("[END USER MEMORY]");
  return { preamble: lines.join("\n"), summaries, preferences };
}

/**
 * Persist a turn (user message + assistant reply, optionally tool calls)
 * to AgentCore Memory. Strategies run asynchronously in the background to
 * extract summaries / preferences; we just hand them the raw event.
 *
 * Fire-and-forget at the call site — never awaited on the user-visible
 * path so memory latency can't slow the response.
 */
export async function writeMemoryEvent(opts: {
  userSub: string;
  conversationId: string;
  turns: ConversationTurn[];
}): Promise<void> {
  if (!MEMORY_ID || !opts.userSub || !opts.turns.length) return;
  try {
    await client.send(new CreateEventCommand({
      memoryId: MEMORY_ID,
      actorId: opts.userSub,
      // We use conversationId as sessionId so episodic summaries scope to
      // the conversation, not to the (ephemeral) runtime session. Multiple
      // runtime sessions across days for one conversation produce ONE
      // continuous summary, which is the right semantic.
      sessionId: opts.conversationId,
      eventTimestamp: new Date(),
      payload: opts.turns.map((t) => ({
        conversational: {
          content: { text: t.text },
          role: t.role,
        },
      })),
    }));
  } catch (e: any) {
    console.warn(`[memory] writeMemoryEvent failed (actor=${opts.userSub}):`, e?.name || "", e?.message || e);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

const HYDRATE_TIMEOUT_MS = 1500;

async function retrieveRecordsSafe(namespacePath: string, searchQuery: string): Promise<string[]> {
  try {
    const result = await Promise.race([
      client.send(new RetrieveMemoryRecordsCommand({
        memoryId: MEMORY_ID,
        namespacePath,
        searchCriteria: { searchQuery, topK: 5 },
      })),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HYDRATE_TIMEOUT_MS)),
    ]);
    if (!result) {
      console.warn(`[memory] retrieve timed out for ${namespacePath}`);
      return [];
    }
    const summaries = (result as any).memoryRecordSummaries || [];
    return summaries
      .map((r: any) => extractRecordText(r))
      .filter((s: string | undefined): s is string => !!s && s.length > 0);
  } catch (e: any) {
    const name = e?.name || "";
    if (name === "ResourceNotFoundException" || name === "AccessDeniedException") return [];
    console.warn(`[memory] retrieve failed (${namespacePath}):`, name, e?.message || e);
    return [];
  }
}

function extractRecordText(record: any): string | undefined {
  const c = record?.content;
  let text: string | undefined;
  if (typeof c?.text === "string") text = c.text;
  else if (typeof record?.text === "string") text = record.text;
  else if (c?.json !== undefined) {
    try { text = JSON.stringify(c.json); } catch { /* drop */ }
  } else if (typeof c === "object" && c !== null) {
    try { text = JSON.stringify(c); } catch { /* drop */ }
  }
  if (typeof text !== "string" || !text.trim()) return undefined;
  return text.replace(/\s+/g, " ").trim();
}
