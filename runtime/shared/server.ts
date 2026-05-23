/**
 * AgentCore Runtime entrypoint using the official bedrock-agentcore SDK.
 *
 * BedrockAgentCoreApp from `bedrock-agentcore/runtime` wraps the HTTP
 * server boilerplate (`/ping`, `/invocations`, SSE streaming for async
 * generators) so we only have to implement the invocation handler. The
 * server listens on PORT (default 8080) — matches the AgentCore Runtime
 * container contract for direct-code-deploy (NODE_22).
 *
 * Streaming: returning an async generator from the handler makes the SDK
 * emit Server-Sent Events automatically, which the chatMessage Lambda
 * (WS-5) consumes via InvokeAgentRuntimeCommand's response stream and
 * forwards as WebSocket `token` / `toolResult` / `final` / `error` frames.
 */

import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";
import { runOrchestratedTurn, type RunEvent } from "./orchestrator.js";
import { extractAuthFromInvocation, AuthContext } from "./auth.js";

export interface ServerOptions {
  /** Hard-coded agent type for this runtime. Pins userType regardless of
   *  what the caller claimed so a misrouted call can't run pro logic in
   *  the clinic container or vice versa. */
  agentType: AuthContext["userType"];
}

/**
 * AgentCore Runtime invocation payload shape. The chatMessage Lambda
 * (WS-5) builds this when calling InvokeAgentRuntimeCommand:
 *   {
 *     input:   { userText: "..." },
 *     context: {
 *       identity: { userSub, userType, userGroups, email, clinics },
 *       session:  { conversationId, runtimeSessionId }
 *     }
 *   }
 * SDK-provided `context` (second handler arg) gives us sessionId; identity
 * + conversationId we pull from `payload.context` since AgentCore Runtime
 * doesn't yet surface JWT claims through its own context object.
 */
interface InvocationPayload {
  input?: { userText?: string; text?: string };
  context?: {
    identity?: Record<string, any>;
    session?: { conversationId?: string };
  };
  // Allow flat shorthand for local `agentcore dev` testing.
  userText?: string;
  prompt?: string;
}

export function startServer(opts: ServerOptions): void {
  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      // Async generator → SDK streams as SSE automatically. The yielded
      // values become the InvokeAgentRuntime response stream that
      // chatMessage Lambda parses.
      process: async function* (rawPayload: unknown, sdkContext: { sessionId: string }) {
        const payload = (rawPayload || {}) as InvocationPayload;

        // ── Auth ──
        let auth: AuthContext;
        try {
          auth = extractAuthFromInvocation(payload);
          // Pin to this container's role — never trust the caller's claim.
          auth.userType = opts.agentType;
        } catch (e: any) {
          yield { data: { type: "error", reason: "unauthorized", detail: e?.message || String(e) } satisfies RunEvent };
          return;
        }

        // ── Input ──
        const userText =
          payload.input?.userText ||
          payload.input?.text ||
          payload.userText ||
          payload.prompt ||
          "";
        if (!userText || typeof userText !== "string") {
          yield { data: { type: "error", reason: "invalid_input", detail: "input.userText is required" } satisfies RunEvent };
          return;
        }

        // ── Conversation scope ──
        // Prefer the explicit conversationId from the caller. Fall back to
        // the AgentCore Runtime sessionId — once WS-5 maps sessionId↔
        // conversationId via the Conversations table, these converge.
        const conversationId =
          payload.context?.session?.conversationId ||
          sdkContext.sessionId ||
          `legacy-${auth.userSub}`;

        // ── Run ──
        // runAgentTurn streams events via its onEvent callback. We hoist
        // those into the async-generator output channel so the SDK can
        // emit them as SSE. A small queue bridges the two: onEvent pushes
        // into it, the generator drains it.
        const queue: RunEvent[] = [];
        let done = false;
        let resolveWait: (() => void) | null = null;

        const runPromise = runOrchestratedTurn({
          auth,
          conversationId,
          userText,
          onEvent: (ev: RunEvent) => {
            queue.push(ev);
            if (resolveWait) { resolveWait(); resolveWait = null; }
          },
        }).finally(() => {
          done = true;
          if (resolveWait) { resolveWait(); resolveWait = null; }
        });

        // Drain pattern: keep yielding while runAgentTurn is producing
        // events; sleep on a promise between batches so the event loop
        // doesn't spin. Terminates when runAgentTurn finishes AND the
        // queue is empty.
        //
        // SSE wrapping: BedrockAgentCoreApp's _normalizeSSEChunk treats any
        // yielded object with a top-level `data` field as a finished
        // SSESource and serializes ONLY that `data` field — dropping any
        // other keys (our `type`, `tool`, `ok`). Tokens accidentally worked
        // because they had no `data` field. To make every RunEvent survive
        // the round trip intact, wrap as `{ data: ev }` so the whole event
        // becomes the SSE payload. The chatMessage Lambda's runtimeInvoker
        // then JSON-parses one full RunEvent per `data:` line.
        while (true) {
          while (queue.length > 0) {
            const ev = queue.shift()!;
            yield { data: ev };
          }
          if (done) break;
          await new Promise<void>((resolve) => { resolveWait = resolve; });
        }
        await runPromise; // surface any unexpected throw to logs
      },
    },
  });

  // Hook into the SDK's underlying Fastify instance via the (technically
  // private) _app field to do two things on /invocations:
  //   1. LOG the Accept header so we can confirm what AgentCore actually
  //      forwarded — useful diagnostic for future SSE handshake issues.
  //   2. FORCE Accept to include "text/event-stream" if it doesn't already.
  //      The BedrockAgentCoreApp SDK + @fastify/sse plugin only set
  //      `reply.sse` when Accept contains that mime; otherwise the
  //      async-generator handler path returns 406. AgentCore's proxy
  //      appears to drop/replace the Accept header from
  //      InvokeAgentRuntimeCommand's `accept` parameter, so we coerce it
  //      here. Safe because every handler in this container streams.
  const fastifyApp = (app as any)._app;
  if (fastifyApp && typeof fastifyApp.addHook === "function") {
    fastifyApp.addHook("onRequest", async (request: any) => {
      if (request.url !== "/invocations") return;
      const incoming = request.headers.accept || "";
      request.log.info(
        { incoming_accept: incoming, content_type: request.headers["content-type"] },
        "[runtime] /invocations headers",
      );
      if (!incoming.includes("text/event-stream")) {
        request.headers.accept = "text/event-stream";
      }
    });
  } else {
    console.warn("[runtime] couldn't attach onRequest hook — SDK shape changed");
  }

  app.run();
  console.log(`[runtime:${opts.agentType}] started`);
}
