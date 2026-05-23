/**
 * Wraps @aws-sdk/client-bedrock-agent-runtime's InvokeAgentCommand for the
 * orchestrator. Single responsibility: call Bedrock Agents and return the
 * raw async stream of ResponseStream events. Translation happens in
 * traceToFrame.ts.
 *
 * Identity propagation: Bedrock Agents has no first-class concept of caller
 * IAM identity at invocation time. We pass userSub / userType / email /
 * clinics as `promptSessionAttributes` (string map) — the dispatcher Lambda
 * deserializes them in its Bedrock-envelope branch. See
 * lambda/src/handlers/chat-gateway/wrapperDispatch.ts bedrockToGatewayEvent().
 *
 * Memory injection: the orchestrator passes the AgentCore Memory preamble
 * as a `sessionAttributes.memory_preamble` so the agent can pull it into
 * context. (Bedrock Agents' SESSION_SUMMARY auto-injects its own summary
 * separately — both layers stack for belt-and-suspenders multi-day recall.)
 */

import {
  BedrockAgentRuntimeClient,
  InvokeAgentCommand,
} from "@aws-sdk/client-bedrock-agent-runtime";
import type { AuthContext } from "./auth.js";

const REGION = process.env.AWS_REGION || "us-east-1";
const client = new BedrockAgentRuntimeClient({ region: REGION });

export interface InvokeAgentOpts {
  agentId: string;
  agentAliasId: string;
  sessionId: string;
  userText: string;
  auth: AuthContext;
  memoryPreamble: string;
}

/**
 * Returns the SDK's response object; the orchestrator iterates
 * `response.completion` (an async iterable of ResponseStream events).
 */
export async function invokeBedrockAgent(opts: InvokeAgentOpts) {
  const promptSessionAttributes: Record<string, string> = {
    identity_user_sub: opts.auth.userSub,
    identity_user_type: opts.auth.userType,
    identity_email: opts.auth.email || "",
    identity_user_groups_json: JSON.stringify(opts.auth.userGroups || []),
    identity_clinics_json: JSON.stringify(opts.auth.clinics || []),
  };
  const sessionAttributes: Record<string, string> = {};
  if (opts.memoryPreamble) {
    // Truncate to a safe size — Bedrock caps sessionAttributes value length.
    sessionAttributes.memory_preamble = opts.memoryPreamble.slice(0, 2000);
  }

  const command = new InvokeAgentCommand({
    agentId: opts.agentId,
    agentAliasId: opts.agentAliasId,
    sessionId: opts.sessionId,
    inputText: opts.userText,
    enableTrace: true, // required so we get tool-call observation events
    sessionState: {
      sessionAttributes,
      promptSessionAttributes,
    },
  });
  return client.send(command);
}
