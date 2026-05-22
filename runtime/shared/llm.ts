/**
 * Bedrock Converse API client + LangChain ChatModel wrapper.
 *
 * All three agents share one foundation model — Claude Haiku 4.5 — because
 * the existing Bedrock Agents path uses it and we want behaviour parity
 * during migration. LangGraph's `createReactAgent` / state-machine APIs
 * speak a generic ChatModel interface, so any LangChain-compatible model
 * plugs in here.
 *
 * Configuration:
 *   - BEDROCK_REGION (env)  — which region to call Bedrock in; defaults to
 *     us-east-1 to match the rest of the stack.
 *   - BEDROCK_MODEL_ID (env) — override the foundation model. Leave unset
 *     to use Haiku 4.5 (matches CDK / CfnAgent declarations).
 *
 * Token streaming: the LangGraph runtime streams via the standard ChatModel
 * `streamEvents()` API; the chat-handler relays those events back to the
 * WebSocket as `token` frames. See `plan.ts` for the actual streaming hook.
 */

import { ChatBedrockConverse } from "@langchain/aws";

const REGION = process.env.BEDROCK_REGION || process.env.AWS_REGION || "us-east-1";
const MODEL_ID = process.env.BEDROCK_MODEL_ID || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Build a fresh ChatBedrockConverse instance for the runtime. Stateless —
 * call once per agent container init (or on every invocation; the SDK
 * memoizes credentials internally).
 */
export function createLLM(opts: { temperature?: number } = {}): ChatBedrockConverse {
  return new ChatBedrockConverse({
    region: REGION,
    model: MODEL_ID,
    temperature: opts.temperature ?? 0,
    // Streaming is enabled at call time via the agent's astream/streamEvents
    // — no per-instance flag needed.
  });
}

export const LLM_REGION = REGION;
export const LLM_MODEL_ID = MODEL_ID;
