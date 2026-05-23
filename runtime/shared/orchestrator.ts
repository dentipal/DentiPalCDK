/**
 * Per-turn orchestrator. Replaces the LangGraph-based runAgentTurn in
 * plan.ts.
 *
 * Responsibilities (in order, single pass):
 *   1. Hydrate AgentCore Memory (episodic + semantic) for this user/convo.
 *   2. Call Bedrock Agents' InvokeAgent with conversationId as sessionId
 *      and the memory preamble + identity stuffed into session attributes.
 *   3. Translate each streamed event into a RunEvent and call onEvent.
 *      The Lambda forwards these to the browser via WS.
 *   4. After the stream completes, fire-and-forget the AgentCore Memory
 *      CreateEvent for episodic write (user + assistant turn).
 *
 * Errors: caught and emitted as `error` events; the function never throws
 * to the caller. Same contract as the old runAgentTurn so server.ts didn't
 * need any other changes.
 */

import { hydrateMemory, writeMemoryEvent } from "./memory.js";
import { invokeBedrockAgent } from "./bedrockAgentsClient.js";
import { translateStreamEvent, type RunEvent, type TranslatorState } from "./traceToFrame.js";
import type { AuthContext } from "./auth.js";

export type { RunEvent } from "./traceToFrame.js";

export interface RunOptions {
  auth: AuthContext;
  conversationId: string;
  userText: string;
  onEvent: (event: RunEvent) => Promise<void> | void;
}

/**
 * Per-agent Bedrock IDs sourced from env vars at module load. The CDK
 * stack (lib/chat-runtime.ts) sets BEDROCK_AGENT_{PRO,CLINIC,PUBLIC}_ID +
 * _ALIAS_ID env vars from the chatbot stack's exports.
 */
const AGENT_IDS = {
  professional: {
    id: process.env.BEDROCK_AGENT_PRO_ID || "",
    aliasId: process.env.BEDROCK_AGENT_PRO_ALIAS_ID || "",
  },
  clinic: {
    id: process.env.BEDROCK_AGENT_CLINIC_ID || "",
    aliasId: process.env.BEDROCK_AGENT_CLINIC_ALIAS_ID || "",
  },
  public: {
    id: process.env.BEDROCK_AGENT_PUBLIC_ID || "",
    aliasId: process.env.BEDROCK_AGENT_PUBLIC_ALIAS_ID || "",
  },
} as const;

/**
 * One user turn end-to-end.
 *
 * Implementation note on session IDs: Bedrock Agents requires sessionId
 * to match `^[0-9a-zA-Z._:-]+$`. Our conversationIds are UUIDs (dashes
 * are allowed). If a future migration loosens that to support more
 * characters, we'd need to sanitize here.
 */
export async function runOrchestratedTurn(opts: RunOptions): Promise<void> {
  const { auth, conversationId, userText, onEvent } = opts;
  const state: TranslatorState = {
    assistantText: "",
    stopReason: "end_turn",
    hadError: false,
  };
  const invMap = new Map<string, { invocationId: string; actionGroup: string; function: string }>();

  try {
    // ── 1. Resolve agent for this caller's role ──
    const agent = AGENT_IDS[auth.userType];
    if (!agent?.id || !agent?.aliasId) {
      await onEvent({
        type: "error",
        reason: "agent_not_configured",
        detail: `No BEDROCK_AGENT_${auth.userType.toUpperCase()}_ID env var set`,
      });
      return;
    }

    // ── 2. Hydrate memory (don't block on errors — fall back to empty) ──
    let memoryPreamble = "";
    try {
      const m = await hydrateMemory({ userSub: auth.userSub, conversationId });
      memoryPreamble = m.preamble || "";
    } catch (e: any) {
      console.warn("[orchestrator] memory hydrate failed (continuing):", e?.message || e);
    }

    // ── 3. Invoke Bedrock Agents ──
    const response = await invokeBedrockAgent({
      agentId: agent.id,
      agentAliasId: agent.aliasId,
      sessionId: conversationId,
      userText,
      auth,
      memoryPreamble,
    });

    if (!response.completion) {
      await onEvent({ type: "error", reason: "empty_completion" });
      return;
    }

    // ── 4. Stream-translate ──
    for await (const event of response.completion as AsyncIterable<any>) {
      const frames = translateStreamEvent(event, invMap, state);
      for (const f of frames) {
        await onEvent(f);
      }
    }

    // ── 5. Final frame if we didn't already error ──
    if (!state.hadError) {
      await onEvent({ type: "final", stopReason: state.stopReason });
    }

    // ── 6. Episodic memory write (fire and forget) ──
    if (state.assistantText) {
      writeMemoryEvent({
        userSub: auth.userSub,
        conversationId,
        turns: [
          { role: "USER", text: userText },
          { role: "ASSISTANT", text: state.assistantText },
        ],
      }).catch((e: any) => {
        console.warn("[orchestrator] memory write failed (ignored):", e?.message || e);
      });
    }
  } catch (e: any) {
    console.error("[orchestrator] turn failed:", e);
    await onEvent({
      type: "error",
      reason: "orchestrator_exception",
      detail: e?.message || String(e),
    });
  }
}
