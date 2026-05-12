import { getSessionByCompositeKey } from "./sessionStore";

const MAX_PREVIEW_AGE_SEC = 5 * 60; // 5 minutes between preview and confirm

export interface PreviewGateOK { ok: true; }
export interface PreviewGateFail { ok: false; status: number; reason: string; }
export type PreviewGateResult = PreviewGateOK | PreviewGateFail;

/**
 * Server-side enforcement: a confirm_* tool call MUST be backed by:
 *  - A pendingPreview row on the session,
 *  - For the same toolName (s/preview_/confirm_/),
 *  - With a previewToken the caller echoed back,
 *  - Created within MAX_PREVIEW_AGE_SEC.
 *
 * This stops a hallucinating model from skipping the confirm card and writing
 * directly. Even if the LLM emits a confirm_* tool call out of nowhere, this
 * gate refuses it.
 */
export async function verifyPreviewBeforeConfirm(
  userSub: string,
  connectionId: string,
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

  const session = await getSessionByCompositeKey(userSub, connectionId);
  if (!session) {
    return { ok: false, status: 410, reason: "Session expired or not found" };
  }
  if (!session.pendingPreview) {
    return { ok: false, status: 409, reason: "No pending preview on this session" };
  }

  const { pendingPreview } = session;
  const expectedPreviewTool = confirmToolName.replace(/^confirm_/, "preview_");
  if (pendingPreview.toolName !== expectedPreviewTool) {
    return {
      ok: false,
      status: 409,
      reason: `Pending preview is for '${pendingPreview.toolName}' but caller tried to confirm '${confirmToolName}'`,
    };
  }
  if (pendingPreview.previewToken !== previewToken) {
    return { ok: false, status: 409, reason: "previewToken mismatch" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - pendingPreview.createdAt > MAX_PREVIEW_AGE_SEC) {
    return { ok: false, status: 409, reason: "Preview expired; ask the user to re-confirm" };
  }

  // Payload sanity check: every key in the stored preview payload must match
  // the value the caller is confirming with. This prevents the model from
  // emitting a preview with rate=$50 and then confirming with rate=$500.
  for (const k of Object.keys(pendingPreview.payload)) {
    const expected = JSON.stringify(pendingPreview.payload[k]);
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
