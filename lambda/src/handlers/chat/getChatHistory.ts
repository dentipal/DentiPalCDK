/**
 * GET /chat/history
 *
 * Returns the authenticated user's chat transcript as a paginated, newest-first
 * page. The frontend renders oldest-at-top by reversing the array; pagination
 * for "load older on scroll up" uses the `nextBefore` cursor from the previous
 * response.
 *
 * Query parameters:
 *   limit  : 1..200, default 50
 *   before : ISO-8601 timestamp; return only messages strictly older than this
 *
 * Auth: Bearer JWT required. Public/anon users have no history.
 */

import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { extractUserFromBearerToken } from "../utils";
import { corsHeaders } from "../corsHeaders";
import { listChatMessages } from "./chatHistoryStore";

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

  const page = await listChatMessages(userSub, { limit, before });

  return json(event, 200, {
    messages: page.messages,
    nextBefore: page.nextBefore,
  });
};
