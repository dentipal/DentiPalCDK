/**
 * Identity envelope passed into the LangGraph state on every invocation.
 *
 * AgentCore Runtime delivers the caller's JWT claims to the agent
 * container via its invocation request. We unpack those claims into a
 * compact AuthContext that every node in the state machine (and every MCP
 * tool call) can consume.
 *
 * The container itself doesn't verify the JWT — AgentCore Runtime's own
 * CUSTOM_JWT authorizer (Cognito-backed) does that before invoking us, so
 * by the time we see the claims they're already validated.
 */

export interface AuthContext {
  userSub: string;
  email?: string;
  userGroups: string[];
  /** Derived from Cognito groups by the chatMessage Lambda before
   *  InvokeAgentRuntime; the container trusts this verbatim. */
  userType: "clinic" | "professional" | "public";
  /** Optional clinics cache forwarded from the runtime caller so the MCP
   *  tools' clinicIds-normalizer can resolve names → UUIDs without an
   *  extra round-trip. Populated by the chatMessage Lambda from
   *  ChatConversations.userContext when WS-5 ships. */
  clinics?: Array<{ clinicId: string; name?: string }>;
}

/**
 * Pull AuthContext out of an AgentCore Runtime invocation envelope. The
 * runtime passes claims under `context.identity` (verify against the
 * AgentCore Runtime SDK before deploy — names may differ slightly).
 *
 * Throws on missing `userSub` because every tool call depends on it for
 * authorization scoping. Callers (the Express entry point) translate the
 * throw into a 401 invocation response.
 */
export function extractAuthFromInvocation(payload: Record<string, any>): AuthContext {
  const identity = payload?.context?.identity ?? payload?.identity ?? {};
  const userSub: string = identity.userSub || identity.sub || "";
  if (!userSub) {
    throw new Error("AgentCore Runtime invocation missing identity.userSub");
  }
  const rawType = String(identity.userType || "professional").toLowerCase();
  const userType: AuthContext["userType"] =
    rawType === "clinic" ? "clinic" : rawType === "public" ? "public" : "professional";
  return {
    userSub,
    email: identity.email,
    userGroups: Array.isArray(identity.userGroups) ? identity.userGroups : [],
    userType,
    clinics: Array.isArray(identity.clinics) ? identity.clinics : undefined,
  };
}
