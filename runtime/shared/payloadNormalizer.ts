/**
 * Normalize tool response payloads into the shape ResultCards.tsx expects.
 *
 * The 50 existing Lambda handlers return inconsistent envelopes:
 *   - `{ jobs: [...] }` (top-level array)              — JobResultsList card
 *   - `{ data: { applications: [...] } }` (nested)     — ApplicationsList card (but UI looks at payload.applications)
 *   - `{ data: { profiles: <obj> } }` (object, not array) — ProfessionalProfileCard
 *   - `{ message, invitations: [...] }`                — InvitationsList card
 * etc.
 *
 * ResultCards.tsx routes on top-level array field names (`jobs`, `clinics`,
 * `applicants`, `applications`, `invitations`, `shifts`, `byJobId`). Anything
 * wrapped in `{data:{...}}` falls through and renders as plain text.
 *
 * This module is the single chokepoint that unwraps + remaps so the cards
 * keep rendering exactly as they did pre-migration. The 50 handlers stay
 * untouched (they serve the website too — out of scope to change).
 */

/**
 * Best-effort: take whatever the dispatcher returned for a tool call and
 * return a payload shape the existing ResultCards.tsx can discriminate on.
 *
 * Rules in order:
 *   1. If the body already has any of the known top-level discriminator
 *      keys (jobs/clinics/etc.), return as-is.
 *   2. If wrapped in `{data:{...}}`, hoist the `data` contents to the top
 *      level so the discriminator keys surface.
 *   3. Per-tool overrides: e.g. `respond_invitation` returns a single
 *      invitation object — wrap it as `{invitations:[result]}` so the
 *      InvitationsList card renders.
 *   4. Otherwise, return the payload unchanged. The UI falls back to
 *      plain-text rendering and the agent's natural-language reply still
 *      describes the result.
 */
export function normalizeToolPayload(toolName: string, rawBody: any): any {
  if (rawBody == null || typeof rawBody !== "object") return rawBody;

  // Strip the dispatcher's outer ok-wrapper if present:
  //   { ok: true, data: <actual handler body> }
  //   { ok: false, status, error }
  let body: any = rawBody;
  if (typeof body.ok === "boolean") {
    if (body.ok === false) {
      // Surface the error verbatim — the trace translator wraps it as
      // toolResult.error.
      return { error: body.error, status: body.status };
    }
    if (body.data !== undefined) body = body.data;
  }
  if (body == null || typeof body !== "object") return body;

  // Rule 1: already has a discriminator key.
  if (hasDiscriminator(body)) return body;

  // Rule 2: hoist a {data:{...}} wrapper.
  if (body.data && typeof body.data === "object" && hasDiscriminator(body.data)) {
    return { ...body.data, ...stripDiscriminators(body) };
  }

  // Rule 3: per-tool overrides.
  const override = perToolRemap(toolName, body);
  if (override) return override;

  // Rule 4: pass-through.
  return body;
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

/** Discriminator keys ResultCards.tsx checks for in payload (per the Explore
 *  agent's audit of dentipal/src/components/ChatWidget/ResultCards.tsx). */
const DISCRIMINATORS = [
  "jobs",
  "clinics",
  "applicants",
  "applications",
  "invitations",
  "shifts",
  "byJobId",
  "professional", // single-profile card
  "profiles",     // list-of-profiles card
] as const;

function hasDiscriminator(body: any): boolean {
  if (!body || typeof body !== "object") return false;
  for (const k of DISCRIMINATORS) {
    if (body[k] !== undefined) return true;
  }
  return false;
}

/** Return a shallow copy of `body` with all discriminator keys removed —
 *  used when we hoist `data.X` so we don't double-emit X. */
function stripDiscriminators(body: any): any {
  const out: any = {};
  for (const k of Object.keys(body)) {
    if (!(DISCRIMINATORS as readonly string[]).includes(k) && k !== "data") {
      out[k] = body[k];
    }
  }
  return out;
}

/**
 * Per-tool key remaps for cases where the handler returns a shape the UI
 * doesn't recognize on its own. Add entries here as new shape mismatches
 * surface from end-to-end testing.
 */
function perToolRemap(toolName: string, body: any): any | null {
  switch (toolName) {
    case "respond_invitation":
    case "confirm_respond_invitation":
      // Returns a single updated invitation object — wrap so the
      // InvitationsList card renders the one row.
      if (body && typeof body === "object" && (body.jobId || body.invitationId)) {
        return { invitations: [body] };
      }
      return null;
    case "get_professional_info":
      // Handler returns { data: { profiles: <obj> } } already hoisted by
      // Rule 2 above to { profiles: <obj> }. The card expects
      // { professional: <obj> } for a single-profile render.
      if (body && body.profiles && !Array.isArray(body.profiles)) {
        return { professional: body.profiles };
      }
      return null;
    default:
      return null;
  }
}
