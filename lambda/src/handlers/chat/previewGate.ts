import { getPreview, deletePreview, PREVIEW_TTL_SECONDS } from "./previewGateStore";

export interface PreviewGateOK { ok: true; }
export interface PreviewGateFail { ok: false; status: number; reason: string; }
export type PreviewGateResult = PreviewGateOK | PreviewGateFail;

/**
 * Server-side enforcement: a confirm_* tool call MUST be backed by:
 *  - A row in PreviewGates keyed by (userSub, previewToken),
 *  - For the same toolName (s/preview_/confirm_/),
 *  - Created within PREVIEW_TTL_SECONDS,
 *  - With a payload whose values match what the model previewed.
 *
 * This stops a hallucinating model from skipping the confirm card and writing
 * directly. Even if the LLM emits a confirm_* tool call out of nowhere, this
 * gate refuses it.
 *
 * Signature note: dropped `connectionId` vs. the previous version. The gate
 * now lives in its own table keyed by (userSub, previewToken), so the
 * caller's WebSocket connection identity is irrelevant — what matters is
 * that the user owns the token and the token hasn't expired. This lets the
 * gate keep working across AgentCore Runtime session migrations and across
 * disconnect/reconnect cycles.
 */
export async function verifyPreviewBeforeConfirm(
  userSub: string,
  confirmToolName: string,
  previewToken: string | undefined,
  payload: Record<string, any>
): Promise<PreviewGateResult> {
  if (!confirmToolName.startsWith("confirm_")) {
    return { ok: false, status: 400, reason: "previewGate only applies to confirm_* tools" };
  }
  if (!previewToken) {
    return { ok: false, status: 409, reason: "confirm_* requires a previewToken from a prior preview_* call" };
  }

  const row = await getPreview(userSub, previewToken);
  if (!row) {
    return { ok: false, status: 409, reason: "No pending preview for this token (expired or never existed)" };
  }

  const expectedPreviewTool = confirmToolName.replace(/^confirm_/, "preview_");
  if (row.toolName !== expectedPreviewTool) {
    return {
      ok: false,
      status: 409,
      reason: `Pending preview is for '${row.toolName}' but caller tried to confirm '${confirmToolName}'`,
    };
  }

  // Belt-and-suspenders: getPreview already filters expired rows, but the
  // ttl column is in epoch seconds and getPreview's check uses absolute
  // time; this branch enforces the same window in case clocks drift.
  const ageSec = Math.floor(Date.now() / 1000) - row.createdAt;
  if (ageSec > PREVIEW_TTL_SECONDS) {
    return { ok: false, status: 409, reason: "Preview expired; ask the user to re-confirm" };
  }

  // Payload sanity check: every key in the stored preview payload must match
  // the value the caller is confirming with. This prevents the model from
  // emitting a preview with rate=$50 and then confirming with rate=$500.
  for (const k of Object.keys(row.payload)) {
    const expected = JSON.stringify(row.payload[k]);
    const got = JSON.stringify(payload[k]);
    if (expected !== got) {
      return {
        ok: false,
        status: 409,
        reason: `Payload field '${k}' differs from previewed value`,
      };
    }
  }

  return { ok: true };
}

/**
 * Burn the preview row after a successful confirm. Re-exported here so
 * call sites don't have to import previewGateStore directly — keeps the
 * "preview gate" concept behind one module boundary.
 */
export async function clearPreviewAfterConfirm(
  userSub: string,
  previewToken: string,
): Promise<void> {
  await deletePreview(userSub, previewToken);
}
