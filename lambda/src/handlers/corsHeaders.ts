// Centralized CORS configuration — pure function only.
// No module state — origin is resolved per-event each call.

const ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://main.d3agcvis750ojb.amplifyapp.com",
];

const STATIC_HEADERS: Record<string, string> = {
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
    "Access-Control-Allow-Methods": "OPTIONS,GET,POST,PUT,PATCH,DELETE",
    "Access-Control-Allow-Credentials": "true",
    "Vary": "Origin",
};

function resolveOrigin(event: any): string {
    const origin = event?.headers?.origin || event?.headers?.Origin || "";
    return ALLOWED_ORIGINS.includes(origin) ? origin : "";
}

/**
 * Pure CORS-headers builder. Derives Access-Control-Allow-Origin from the
 * given event each call — no shared module state. Pass the Lambda event
 * (or any object with .headers) to receive headers tailored to that request.
 */
export function corsHeaders(event: any): Record<string, string> {
    return {
        "Access-Control-Allow-Origin": resolveOrigin(event),
        ...STATIC_HEADERS,
    };
}
