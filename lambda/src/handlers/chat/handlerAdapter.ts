import { AuthContext } from "../utils";

/**
 * Loose handler shape — accepts both v1 (`APIGatewayProxyEvent` /
 * `APIGatewayProxyResult`) and v2 (`APIGatewayProxyEventV2` /
 * `APIGatewayProxyResultV2`) signatures the existing handlers use. The
 * adapter constructs an event object that includes the fields both shapes
 * read (`httpMethod`, `path`, `headers`, `body`, `pathParameters`,
 * `queryStringParameters`, plus the `requestContext.http.method` fallback v2
 * handlers check). At runtime the handler reads whichever fields it expects.
 */
export type LooseHandler = (event: any) => Promise<{ statusCode?: number; body?: any; headers?: any } | any>;

/**
 * Adapter that lets the chatbot toolExecutor call any existing API-Gateway-style
 * Lambda handler IN-PROCESS without an HTTP round-trip.
 *
 * Two mechanisms in play, used together:
 *   1. `_inProcessAuth` on the synthetic event — picked up by the refactored
 *      handlers that use `extractAuthFromEvent` (createJobApplication-prof,
 *      browseJobPostings, getJobInvitations). Cheapest, no JWT decode.
 *   2. Synthetic unsigned JWT in the Authorization header — handlers that
 *      still call `extractUserFromBearerToken` directly will decode the
 *      payload and continue. SAFE because:
 *        - The token is constructed in-process and never leaves the Lambda.
 *        - Real API Gateway traffic passes through the Cognito authorizer
 *          first, which rejects unsigned tokens — so an external attacker
 *          cannot reach the handler with an unsigned JWT.
 *        - `extractUserFromBearerToken` was always signature-trusting (it
 *          relied on API Gateway to verify). We're not weakening that; we're
 *          using the same existing trust boundary from inside it.
 *
 * Result shape mirrors the refactored `run*` contract: `{status, body}` where
 * body is JSON-parsed when possible.
 */

export interface CallHandlerOptions {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  pathParameters?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: any;
  auth: AuthContext;
}

export interface AdapterResult {
  status: number;
  body: any;
}

const b64url = (s: string): string =>
  Buffer.from(s, "utf-8").toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function buildSyntheticAccessToken(auth: AuthContext): string {
  const header = b64url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = b64url(JSON.stringify({
    sub: auth.userSub,
    "cognito:groups": auth.userGroups,
    "custom:user_type": auth.userType,
    email: auth.email || "",
    token_use: "access",
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 900, // matches session TTL
  }));
  return `${header}.${payload}.synthetic`;
}

export async function callHandlerInProcess(
  handler: LooseHandler,
  options: CallHandlerOptions,
): Promise<AdapterResult> {
  const synthetic = buildSyntheticAccessToken(options.auth);
  const event: any = {
    httpMethod: options.method,
    path: "/",
    pathParameters: options.pathParameters || null,
    queryStringParameters: options.queryStringParameters || null,
    headers: { Authorization: `Bearer ${synthetic}` },
    body: options.body !== undefined ? JSON.stringify(options.body) : null,
    requestContext: { http: { method: options.method } },
    _inProcessAuth: options.auth, // refactored handlers prefer this
  };

  const result: any = await handler(event);

  let body: any = result?.body;
  try {
    body = typeof result?.body === "string" ? JSON.parse(result.body) : result?.body;
  } catch {
    // body wasn't JSON — keep raw.
  }
  return { status: result?.statusCode ?? 500, body };
}
