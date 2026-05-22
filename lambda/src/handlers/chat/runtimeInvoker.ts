/**
 * AgentCore Runtime invocation path for the chatMessage Lambda (WS-5).
 *
 * When the `chatbot=true` CDK flag is on, the chatMessage Lambda receives
 * three env vars — BEDROCK_RUNTIME_{PROFESSIONAL,CLINIC,PUBLIC}_ARN — that
 * point at the deployed AgentCore Runtime agents (WS-4). Whenever one is
 * set for the current session's agentType, the Lambda calls
 * InvokeAgentRuntime here instead of the legacy Bedrock Agents path.
 *
 * The runtime emits server-sent-events (newline-delimited JSON, each line
 * a RunEvent from runtime/shared/plan.ts: token / toolResult / final /
 * error). We translate those 1:1 into WebSocket frames the widget already
 * understands, so the frontend doesn't need a separate code path for
 * runtime vs. legacy Bedrock Agents.
 *
 * Behavior gates:
 *   - If no runtime ARN is set for the session's agentType, this module's
 *     entry point returns `{ routed: false }` and chatMessage.ts falls
 *     back to the legacy InvokeAgentCommand loop.
 *   - Confirm-path (preview/confirm gate) bypass is unchanged — that
 *     short-circuits before invoke either way.
 */

import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
  GoneException,
} from "@aws-sdk/client-apigatewaymanagementapi";
import type { AgentType } from "./sessionStore";

const REGION = process.env.REGION || "us-east-1";

const RUNTIME_PROFESSIONAL_ARN = process.env.BEDROCK_RUNTIME_PROFESSIONAL_ARN || "";
const RUNTIME_CLINIC_ARN = process.env.BEDROCK_RUNTIME_CLINIC_ARN || "";
const RUNTIME_PUBLIC_ARN = process.env.BEDROCK_RUNTIME_PUBLIC_ARN || "";

const agentCoreClient = new BedrockAgentCoreClient({ region: REGION });

/**
 * Returns the runtime ARN for a given agentType, or empty string when no
 * ARN is configured. Callers use the empty case as the signal to fall back
 * to the legacy Bedrock Agents invocation path.
 */
export function getRuntimeArn(agentType: AgentType): string {
  if (agentType === "professional") return RUNTIME_PROFESSIONAL_ARN;
  if (agentType === "clinic") return RUNTIME_CLINIC_ARN;
  if (agentType === "public") return RUNTIME_PUBLIC_ARN;
  return "";
}

/** True when ANY runtime ARN is configured — used as a coarse "are we in
 *  WS-4 mode" check. */
export function anyRuntimeConfigured(): boolean {
  return !!(RUNTIME_PROFESSIONAL_ARN || RUNTIME_CLINIC_ARN || RUNTIME_PUBLIC_ARN);
}

export interface RuntimeInvokeOptions {
  /** The matching runtime ARN (from getRuntimeArn). */
  runtimeArn: string;
  /** Stable per-conversation key — AgentCore Runtime uses it to keep the
   *  same warm container assigned to one conversation. We pass the
   *  conversationId here so each conversation gets its own runtime
   *  session; reusing across conversations would leak working memory. */
  runtimeSessionId: string;
  /** The user's text from this turn. */
  userText: string;
  /** Auth + conversation context forwarded to the runtime; the runtime
   *  agent uses this to authorize tool calls and scope memory. */
  identity: {
    userSub: string;
    userType: AgentType;
    userGroups: string[];
    email?: string;
    /** Forwarded to enable clinic-name → UUID resolution in tool calls. */
    clinics?: Array<{ clinicId: string; name?: string }>;
  };
  conversationId: string;
  /** Where to push WS frames. The runtime emits events one at a time; we
   *  translate and post each. */
  api: ApiGatewayManagementApiClient;
  connectionId: string;
}

export interface RuntimeInvokeResult {
  /** Concatenated assistant text across this turn, for the chatMessage
   *  Lambda's memory + transcript writes. */
  assistantText: string;
  /** Final stop reason (`end_turn`, `error`, etc.) — used for logging
   *  and for the legacy memory-write stopReason tag. */
  stopReason: string;
  /** True iff the runtime emitted a terminal error event. The Lambda
   *  uses this to decide whether to retry or surface the error. */
  hadError: boolean;
}

/**
 * Invoke the agent runtime and stream back as WS frames.
 *
 * Behavior contract (mirrors what runtime/shared/plan.ts emits):
 *   - `token`       — append to the streaming assistant message bubble
 *   - `toolResult`  — render as a tool-result row (or confirm card)
 *   - `final`       — turn ended cleanly; the bubble finalizes
 *   - `error`       — surface the error and finalize
 *
 * The function aggregates assistant text across all tokens so the caller
 * can persist the full turn to ChatMessages + AgentCore Memory.
 */
export async function invokeAgentRuntime(opts: RuntimeInvokeOptions): Promise<RuntimeInvokeResult> {
  const result: RuntimeInvokeResult = {
    assistantText: "",
    stopReason: "end_turn",
    hadError: false,
  };

  // Payload shape matches runtime/shared/server.ts's expectations.
  const payload = {
    input: { userText: opts.userText },
    context: {
      identity: opts.identity,
      session: { conversationId: opts.conversationId },
    },
  };

  const command = new InvokeAgentRuntimeCommand({
    agentRuntimeArn: opts.runtimeArn,
    runtimeSessionId: opts.runtimeSessionId,
    payload: Buffer.from(JSON.stringify(payload)),
    contentType: "application/json",
    accept: "application/x-ndjson",
    qualifier: "DEFAULT",
  });

  const response = await agentCoreClient.send(command);
  if (!response.response) {
    await postFrame(opts.api, opts.connectionId, {
      type: "error",
      reason: "empty_runtime_response",
    });
    result.hadError = true;
    result.stopReason = "empty_completion";
    return result;
  }

  // SDK gives the response as a Uint8Array stream. We accumulate bytes
  // and split on newlines — each line is one JSON event.
  let buffer = "";
  const decoder = new TextDecoder("utf-8");

  // The exact stream shape on @aws-sdk/client-bedrock-agentcore depends
  // on SDK version. We probe both common shapes: `transformToWebStream()`
  // and the raw async-iterable. Either way each chunk decodes to text.
  const stream: any = response.response;
  let asyncIter: AsyncIterable<Uint8Array> | undefined;
  if (typeof stream[Symbol.asyncIterator] === "function") {
    asyncIter = stream as AsyncIterable<Uint8Array>;
  } else if (typeof stream.transformToWebStream === "function") {
    const webStream = stream.transformToWebStream();
    asyncIter = webStreamToAsyncIterable(webStream);
  } else if (typeof stream.transformToString === "function") {
    // Non-streaming fallback — read the whole thing then split.
    const full = await stream.transformToString();
    await consumeEventLines(full.split("\n"), opts, result);
    await sendFinalIfMissing(opts, result);
    return result;
  } else {
    await postFrame(opts.api, opts.connectionId, {
      type: "error",
      reason: "unknown_stream_shape",
    });
    result.hadError = true;
    result.stopReason = "stream_shape";
    return result;
  }

  for await (const chunk of asyncIter) {
    buffer += decoder.decode(chunk, { stream: true });
    // Drain complete lines; keep the tail in the buffer for the next chunk.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    await consumeEventLines(lines, opts, result);
    if (result.stopReason === "end_turn" && result.hadError === false) {
      // continue
    }
  }
  // Flush any trailing line (no terminating newline).
  if (buffer.trim()) {
    await consumeEventLines([buffer], opts, result);
  }

  await sendFinalIfMissing(opts, result);
  return result;
}

// ───────────────────────────────────────────────────────────────────────
// Internal helpers
// ───────────────────────────────────────────────────────────────────────

let sawFinalThisInvocation = false; // module-level guard to avoid double-final

async function consumeEventLines(
  lines: string[],
  opts: RuntimeInvokeOptions,
  result: RuntimeInvokeResult,
): Promise<void> {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let ev: any;
    try { ev = JSON.parse(line); }
    catch {
      console.warn("[runtimeInvoker] dropped non-JSON line:", line.slice(0, 200));
      continue;
    }
    await translateAndPost(ev, opts, result);
  }
}

async function translateAndPost(
  ev: any,
  opts: RuntimeInvokeOptions,
  result: RuntimeInvokeResult,
): Promise<void> {
  // ev matches RunEvent from runtime/shared/plan.ts.
  switch (ev?.type) {
    case "token": {
      const delta = String(ev.delta || "");
      if (!delta) return;
      result.assistantText += delta;
      await postFrame(opts.api, opts.connectionId, { type: "token", delta });
      return;
    }
    case "toolResult": {
      await postFrame(opts.api, opts.connectionId, {
        type: "toolResult",
        tool: ev.tool,
        ok: !!ev.ok,
        data: ev.data,
        error: ev.error,
      });
      return;
    }
    case "final": {
      sawFinalThisInvocation = true;
      result.stopReason = String(ev.stopReason || "end_turn");
      await postFrame(opts.api, opts.connectionId, {
        type: "final",
        stopReason: result.stopReason,
      });
      return;
    }
    case "error": {
      sawFinalThisInvocation = true;
      result.hadError = true;
      result.stopReason = String(ev.reason || "agent_failure");
      await postFrame(opts.api, opts.connectionId, {
        type: "error",
        reason: ev.reason || "agent_failure",
        detail: ev.detail,
      });
      return;
    }
    default:
      console.warn("[runtimeInvoker] unknown event type:", ev?.type, JSON.stringify(ev).slice(0, 200));
  }
}

async function sendFinalIfMissing(
  opts: RuntimeInvokeOptions,
  result: RuntimeInvokeResult,
): Promise<void> {
  if (sawFinalThisInvocation) {
    sawFinalThisInvocation = false; // reset for next invocation
    return;
  }
  await postFrame(opts.api, opts.connectionId, {
    type: "final",
    stopReason: result.stopReason,
  });
}

async function postFrame(
  api: ApiGatewayManagementApiClient,
  connectionId: string,
  frame: Record<string, any>,
): Promise<void> {
  try {
    await api.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: Buffer.from(JSON.stringify(frame)),
    }));
  } catch (err) {
    if (err instanceof GoneException) {
      console.warn(`postFrame: connection ${connectionId} is gone`);
      return;
    }
    throw err;
  }
}

/** Wrap a web ReadableStream as an AsyncIterable<Uint8Array> — fallback
 *  for SDK versions that don't expose Symbol.asyncIterator on the response
 *  stream directly. */
async function* webStreamToAsyncIterable(stream: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}
