/**
 * GET /chat/history
 *
 * Legacy single-thread reader. New callers should use the
 * /chat/conversations/{conversationId}/messages endpoint instead.
 *
 * Behavior:
 *   - `?conversationId=<id>` present → read that conversation's transcript
 *     (equivalent to the new per-conversation endpoint, kept here so
 *     pre-cutover frontends can opt into the new path without redeploying).
 *   - No conversationId         → read ONLY the legacy thread (the synthetic
 *     `legacy-<userSub>` conversation that the migration backfilled). We
 *     deliberately do NOT return every message across every conversation —
 *     that would mix unrelated threads into a single scroll and confuse a
 *     pre-migration UI that doesn't know about the sidebar yet.
 *
 * Query parameters:
 *   limit          : 1..200, default 50
 *   before         : ISO-8601 timestamp; return only messages strictly older
 *   conversationId : optional override; defaults to `legacy-<userSub>`
 *
 * Auth: Bearer JWT required. Public/anon users have no history.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "../utils";
import { corsHeaders } from "../corsHeaders";
import { listChatMessages, listChatMessagesByConversation, legacyConversationId } from "./chatHistoryStore";

const json = (event: any, statusCode: number, bodyObj: unknown): APIGatewayProxyResult => ({
  statusCode,
  headers: { ...corsHeaders(event), "Content-Type": "application/json" },
  body: JSON.stringify(bodyObj),
});

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const method = event.httpMethod || (event as any).requestContext?.http?.method || "";
  if (method === "OPTIONS") return { statusCode: 200, headers: corsHeaders(event), body: "" };
  if (method !== "GET") return json(event, 405, { error: "Use GET" });

  // Auth required — userSub keys the table partition.
  const authHeader = event.headers?.Authorization || event.headers?.authorization;
  if (!authHeader) return json(event, 401, { error: "Missing Authorization header" });

  let userSub: string | undefined;
  try {
    const userInfo = extractUserFromBearerToken(authHeader);
    userSub = userInfo?.sub;
  } catch {
    return json(event, 401, { error: "Invalid bearer token" });
  }
  if (!userSub) return json(event, 401, { error: "Unable to derive userSub from token" });

  const qs = event.queryStringParameters || {};
  const rawLimit = Number(qs.limit);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.floor(rawLimit) : 50;
  const before = typeof qs.before === "string" && qs.before.length > 0 ? qs.before : undefined;
  const explicitConversationId =
    typeof qs.conversationId === "string" && qs.conversationId.length > 0
      ? qs.conversationId
      : undefined;
  const conversationId = explicitConversationId || legacyConversationId(userSub);

  // Primary path: query the per-conversation GSI. Works for any row written
  // since the WS-1 deploy (including the legacy fallback, since chatMessage
  // now writes conversationId=legacy-<userSub>).
  let page = await listChatMessagesByConversation(conversationId, { limit, before });

  // Migration fallback: existing rows written BEFORE WS-1 don't have the
  // conversationId attribute and so don't appear in the GSI. When the caller
  // is asking for the legacy thread AND the GSI returned nothing, drop back
  // to the base-table reader so the user's old transcript still loads.
  // Only triggers on the legacy default (explicit conversationIds get the
  // strict GSI-only behavior — a missing row really means "no such convo").
  if (!explicitConversationId && page.messages.length === 0) {
    page = await listChatMessages(userSub, { limit, before });
  }

  return json(event, 200, {
    messages: page.messages,
    nextBefore: page.nextBefore,
    conversationId,
  });
};
