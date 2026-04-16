// Centralized CORS configuration
// Dynamically resolves the allowed origin based on the incoming request

const ALLOWED_ORIGINS = [
    "http://localhost:5173",
    "https://main.d3agcvis750ojb.amplifyapp.com"
];

let _currentOrigin: string = ALLOWED_ORIGINS[0];

/**
 * Call at the top of every Lambda handler to set the correct
 * Access-Control-Allow-Origin for the current request.
 * Lambda processes one request at a time, so a module-level
 * variable is safe here.
 */
export function setOriginFromEvent(event: any): void {
    const origin = event?.headers?.origin || event?.headers?.Origin || "";
    _currentOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
}

// CORS_HEADERS uses a getter so the origin is resolved at serialization time
// (when the Lambda runtime calls JSON.stringify on the response).
export const CORS_HEADERS: Record<string, string> = Object.defineProperties(
    {} as Record<string, string>,
    {
        "Access-Control-Allow-Origin": {
            get() { return _currentOrigin; },
            enumerable: true,
        },
        "Access-Control-Allow-Headers": {
            value: "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token,X-Requested-With",
            enumerable: true,
        },
        "Access-Control-Allow-Methods": {
            value: "OPTIONS,GET,POST,PUT,PATCH,DELETE",
            enumerable: true,
        },
        "Access-Control-Allow-Credentials": {
            value: "true",
            enumerable: true,
        },
        "Vary": {
            value: "Origin",
            enumerable: true,
        },
    }
);
