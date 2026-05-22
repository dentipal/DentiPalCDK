/**
 * LangGraph state machine — the per-agent plan/execute/respond loop.
 *
 * Built on `createReactAgent` from @langchain/langgraph/prebuilt: a
 * battle-tested ReAct-style executor that (a) picks tools from a list,
 * (b) calls them, (c) feeds results back to the model, (d) repeats until
 * the model produces a final answer. Behaviorally equivalent to the
 * existing Bedrock Agents loop, just owned by our code.
 *
 * Why prebuilt rather than custom graph: the existing Bedrock Agents path
 * already does plan → execute → reflect implicitly via its tool-loop. The
 * 6-iteration cap in chatMessage.ts (MAX_TOOL_LOOPS) maps to LangGraph's
 * built-in `recursionLimit`. We keep parity by setting the same limit
 * here; richer plan checkpointing (the "I'll watch and tell you later"
 * UX) is added by WS-8, not at the loop level.
 *
 * Streaming: the agent returns an async iterator over LangChain stream
 * events. The Express entry point translates those into AgentCore Runtime
 * streaming payloads → WebSocket `token` / `toolResult` frames.
 */

import { createReactAgent } from "@langchain/langgraph/prebuilt";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { createLLM } from "./llm.js";
import { buildSystemPrompt, toolsetFor } from "./roleAnchor.js";
import { buildMcpTools } from "./mcpTools.js";
import { hydrateMemory, writeMemoryEvent } from "./memory.js";
import type { AuthContext } from "./auth.js";

/** Mirrors chatMessage.ts MAX_TOOL_LOOPS = 6 — same behavior, same cap. */
const RECURSION_LIMIT = 12; // 2 nodes per loop (agent → tools → agent) so 12 ≈ 6 tool rounds

export interface RunOptions {
  auth: AuthContext;
  conversationId: string;
  /** The user's text from this turn. */
  userText: string;
  /** Async callback for streaming output back to the caller. */
  onEvent: (event: RunEvent) => Promise<void> | void;
}

/**
 * Stream events emitted by `runAgentTurn`. The Express entry point
 * translates these into AgentCore Runtime streaming responses → the
 * chatMessage Lambda forwards them as WS frames to the browser.
 */
export type RunEvent =
  | { type: "token"; delta: string }
  | { type: "toolResult"; tool: string; ok: boolean; data?: any; error?: string }
  | { type: "final"; stopReason: string }
  | { type: "error"; reason: string; detail?: string };

/**
 * Execute one user turn end-to-end:
 *   1. Hydrate memory (episodic + semantic).
 *   2. Build the per-invocation toolset (filtered by role).
 *   3. Construct the system prompt (role anchor + memory).
 *   4. Stream the LangGraph ReAct loop, emitting events as they arrive.
 *   5. Persist the turn to AgentCore Memory (fire-and-forget).
 *
 * Errors are caught and emitted as `error` events; the function never
 * throws to the caller — they get a clean per-event handle on what
 * happened.
 */
export async function runAgentTurn(opts: RunOptions): Promise<void> {
  const { auth, conversationId, userText, onEvent } = opts;

  let assistantText = "";

  try {
    // ── 1. Memory hydrate ──
    const memory = await hydrateMemory({ userSub: auth.userSub, conversationId });

    // ── 2. Tools ──
    const allowedToolNames = toolsetFor(auth.userType);
    const tools: DynamicStructuredTool[] = await buildMcpTools({
      auth,
      conversationId,
      allowedTools: allowedToolNames,
    });

    // ── 3. Agent ──
    const llm = createLLM();
    const systemPrompt = buildSystemPrompt({ auth, memoryPreamble: memory.preamble });
    const agent = createReactAgent({
      llm,
      tools,
      // System prompt: prepend on every model call (LangChain handles this
      // internally when the first message is a SystemMessage).
      // Note: the `stateModifier` option also works for this — we use the
      // explicit SystemMessage form because it composes with streamEvents
      // more predictably.
    });

    // ── 4. Stream ──
    const inputMessages = [
      new SystemMessage(systemPrompt),
      new HumanMessage(userText),
    ];

    const stream = await agent.streamEvents(
      { messages: inputMessages },
      { version: "v2", recursionLimit: RECURSION_LIMIT },
    );

    let stopReason = "end_turn";

    for await (const ev of stream) {
      // LangChain v2 stream events surface a tagged union. We care about:
      //   - on_chat_model_stream → token chunk from the LLM
      //   - on_tool_end          → tool finished, emit toolResult
      //   - on_chain_end (root)  → final answer ready
      switch (ev.event) {
        case "on_chat_model_stream": {
          const chunk = (ev.data as any)?.chunk;
          const content = chunk?.content;
          // Content can be a string or an array of typed parts.
          if (typeof content === "string" && content) {
            assistantText += content;
            await onEvent({ type: "token", delta: content });
          } else if (Array.isArray(content)) {
            for (const part of content) {
              if (part?.type === "text" && typeof part.text === "string" && part.text) {
                assistantText += part.text;
                await onEvent({ type: "token", delta: part.text });
              }
            }
          }
          break;
        }
        case "on_tool_end": {
          const name = ev.name || "";
          const output = (ev.data as any)?.output;
          // Output is usually a string (we stringify in the MCP wrapper).
          // Parse JSON when possible so the WS frame's `data` is structured.
          let parsed: any = output;
          if (typeof output === "string") {
            try { parsed = JSON.parse(output); } catch { /* leave as string */ }
          }
          // Honor any explicit error envelope the tool emitted.
          const isErr = parsed && typeof parsed === "object" && parsed.error && !parsed.ok;
          await onEvent({
            type: "toolResult",
            tool: name,
            ok: !isErr,
            data: isErr ? undefined : parsed,
            error: isErr ? String(parsed.error) : undefined,
          });
          break;
        }
        default:
          // ignore on_chat_model_start, on_tool_start, on_chain_start, etc.
          break;
      }
    }

    // ── 5. Persist memory (fire-and-forget) ──
    if (auth.userType !== "public") {
      const turns: Array<{ role: "USER" | "ASSISTANT"; text: string }> = [{ role: "USER", text: userText }];
      if (assistantText.trim()) turns.push({ role: "ASSISTANT", text: assistantText });
      void writeMemoryEvent({ userSub: auth.userSub, conversationId, turns }).catch(() => {});
    }

    await onEvent({ type: "final", stopReason });
  } catch (e: any) {
    const detail = e?.message || String(e);
    // Try to persist whatever we got so memory continuity isn't broken on
    // failure. Same defensive write the legacy chatMessage path does.
    if (auth.userType !== "public" && assistantText.trim()) {
      void writeMemoryEvent({
        userSub: auth.userSub,
        conversationId,
        turns: [{ role: "USER", text: userText }, { role: "ASSISTANT", text: assistantText }],
      }).catch(() => {});
    }
    await onEvent({ type: "error", reason: "agent_failure", detail });
  }
}
