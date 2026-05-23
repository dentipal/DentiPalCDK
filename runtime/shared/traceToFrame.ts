/**
 * Translate the Bedrock Agents ResponseStream into RunEvent frames that the
 * orchestrator pipes back as SSE to the chatMessage Lambda → WebSocket.
 *
 * Stream event shape we care about (from @aws-sdk/client-bedrock-agent-runtime):
 *   - { chunk: { bytes: Uint8Array } }                  — assistant text
 *   - { trace: { trace: { orchestrationTrace: {...} } } } — agent reasoning
 *       sub-shapes we extract:
 *         modelInvocationInput / Output    — ignored (too verbose)
 *         rationale                        — ignored
 *         invocationInput.actionGroupInvocationInput
 *           → records {invocationId, actionGroup, function, parameters[]}
 *             so we can name the matching observation later
 *         observation.actionGroupInvocationOutput
 *           → emit `toolResult` frame with normalized payload
 *         observation.finalResponse.text
 *           → optional final text (often empty when chunks already streamed)
 *   - { trace: { trace: { failureTrace: { failureReason } } } } — emit error
 *   - { internalServerException | throttlingException | accessDeniedException | ...}
 *     → emit error frame and stop
 *
 * Order is not guaranteed — observation events sometimes arrive BEFORE the
 * matching invocationInput (Bedrock's stream isn't strictly causal). We
 * cache invocation context by invocationId so observations can find their
 * tool name regardless of arrival order.
 */

import { normalizeToolPayload } from "./payloadNormalizer.js";

export type RunEvent =
  | { type: "token"; delta: string }
  | { type: "toolResult"; tool: string; ok: boolean; data?: any; error?: string }
  | { type: "final"; stopReason: string }
  | { type: "error"; reason: string; detail?: string };

interface InvocationContext {
  actionGroup: string;
  function: string;
}

export interface TranslatorState {
  /** Concatenated assistant text — useful for transcript persistence. */
  assistantText: string;
  /** Final stopReason — defaults to "end_turn" unless we see a failure. */
  stopReason: string;
  /** Whether any error frame was emitted. */
  hadError: boolean;
  /** Most-recently-seen invocationInput, used to attribute the next
   *  observation to the right tool. Bedrock's observation events do NOT
   *  carry invocationId (only RETURN_CONTROL flows do), so positional
   *  pairing is the only correlation available. */
  pendingInvocation?: InvocationContext;
}

/**
 * Translate one ResponseStream event into zero or more RunEvent frames.
 * The orchestrator calls this for every event, emits each returned frame
 * via its `onEvent` callback, and updates `state` in place.
 */
export function translateStreamEvent(
  raw: any,
  _unused: Map<string, InvocationContext>,
  state: TranslatorState,
): RunEvent[] {
  void _unused; // kept for backward-compat signature; pairing now in state.pendingInvocation

  // DEBUG: log the top-level event shape so we can confirm what Bedrock
  // actually streams. Remove once cards are confirmed rendering.
  const keys = raw && typeof raw === "object" ? Object.keys(raw) : ["<non-object>"];
  console.log("[trace] event keys:", JSON.stringify(keys));
  if (raw?.trace?.trace?.orchestrationTrace) {
    const orch = raw.trace.trace.orchestrationTrace;
    console.log("[trace] orch keys:", JSON.stringify(Object.keys(orch)));
    if (orch.invocationInput?.actionGroupInvocationInput) {
      console.log("[trace] invocationInput.function:", orch.invocationInput.actionGroupInvocationInput.function);
    }
    if (orch.observation) {
      console.log("[trace] observation keys:", JSON.stringify(Object.keys(orch.observation)));
      if (orch.observation.actionGroupInvocationOutput) {
        const textPreview = String(orch.observation.actionGroupInvocationOutput.text || "").slice(0, 200);
        console.log("[trace] actionGroupInvocationOutput.text preview:", textPreview);
      }
    }
  }
  // Top-level service errors first.
  const errorKey = SERVICE_ERROR_KEYS.find((k) => raw?.[k]);
  if (errorKey) {
    const detail = raw[errorKey]?.message || errorKey;
    state.hadError = true;
    state.stopReason = "service_error";
    return [{ type: "error", reason: errorKey, detail }];
  }

  // Assistant text chunk.
  if (raw?.chunk?.bytes) {
    const text = bytesToString(raw.chunk.bytes);
    if (text) {
      state.assistantText += text;
      return [{ type: "token", delta: text }];
    }
    return [];
  }

  // Trace events (orchestration + failures).
  const trace = raw?.trace?.trace;
  if (!trace) return [];

  if (trace.failureTrace) {
    const reason = trace.failureTrace.failureReason || "agent_failure";
    state.hadError = true;
    state.stopReason = "failure";
    return [{ type: "error", reason: "agent_failure", detail: String(reason) }];
  }

  const orch = trace.orchestrationTrace;
  if (!orch) return [];

  // Cache pending invocation context. observation events DON'T carry
  // invocationId for our (Lambda-backed) action groups, so we pair by
  // arrival order: each invocationInput updates state.pendingInvocation,
  // the next matching observation reads + clears it.
  const inInput = orch.invocationInput?.actionGroupInvocationInput;
  if (inInput?.function) {
    state.pendingInvocation = {
      actionGroup: inInput.actionGroupName || "",
      function: inInput.function,
    };
  }

  // Tool result observation.
  const outObs = orch.observation?.actionGroupInvocationOutput;
  if (outObs?.text != null) {
    const toolName = state.pendingInvocation?.function || inInput?.function || "unknown";
    state.pendingInvocation = undefined;
    const parsed = safeParseJson(outObs.text);
    // The dispatcher returns { ok: true, data: <handler body> } or
    // { ok: false, status, error } — wrapped in a Bedrock TEXT response.
    if (parsed && typeof parsed === "object" && parsed.ok === false) {
      return [{
        type: "toolResult",
        tool: toolName,
        ok: false,
        error: parsed.error || `Tool returned ok:false (status ${parsed.status ?? "?"})`,
      }];
    }
    const normalized = normalizeToolPayload(toolName, parsed);
    console.log("[trace] emitting toolResult frame: tool=", toolName, "dataKeys=", JSON.stringify(normalized && typeof normalized === "object" ? Object.keys(normalized) : ["<scalar>"]));
    return [{
      type: "toolResult",
      tool: toolName,
      ok: true,
      data: normalized,
    }];
  }

  // Final-response observation — usually a brief recap of the conclusion.
  // Skip if assistant text already streamed via chunks (avoids duplication).
  // Most of the time, chunks already covered this so we don't emit anything.

  return [];
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

const SERVICE_ERROR_KEYS = [
  "internalServerException",
  "throttlingException",
  "accessDeniedException",
  "validationException",
  "dependencyFailedException",
  "badGatewayException",
  "conflictException",
  "resourceNotFoundException",
  "serviceQuotaExceededException",
  "modelNotReadyException",
];

function bytesToString(bytes: Uint8Array | { type: "Buffer"; data: number[] } | undefined): string {
  if (!bytes) return "";
  if (bytes instanceof Uint8Array) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  // Some SDK versions JSON-serialize Buffer as {type:"Buffer", data:[...]}.
  if ((bytes as any).data && Array.isArray((bytes as any).data)) {
    return new TextDecoder("utf-8").decode(new Uint8Array((bytes as any).data));
  }
  return String(bytes);
}

function safeParseJson(text: string): any {
  if (typeof text !== "string") return text;
  const t = text.trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch { return text; }
}
