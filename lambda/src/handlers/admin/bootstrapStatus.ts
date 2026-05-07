import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { corsHeaders } from "../corsHeaders";

const json = (event: any, statusCode: number, body: object): APIGatewayProxyResult => ({
    statusCode,
    headers: corsHeaders(event),
    body: JSON.stringify(body),
});

/**
 * GET /admin/auth/bootstrap-status — public.
 *
 * Always returns `bootstrapNeeded: true` so /admin/signup is reachable for
 * adding additional admins. The single-shot gate that previously hid the page
 * after the first admin was created has been removed by request — internal
 * team admins can self-register at any time.
 *
 * Field name is preserved for frontend compatibility; treat it as
 * "is the public signup page open?".
 */
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
    if (event.httpMethod === "OPTIONS") {
        return { statusCode: 200, headers: corsHeaders(event), body: "" };
    }
    return json(event, 200, { bootstrapNeeded: true });
};
