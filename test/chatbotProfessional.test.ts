/**
 * Test runner for docs/test-cases/20_ChatBotProfessional.csv
 *
 * Every TC-CBP-### in the CSV is mapped to a `test()` or `test.todo()` here.
 *  - `test()`        — verifiable at the Lambda/tool-executor layer; mocks AWS dependencies.
 *  - `test.todo()`   — UI / WebSocket / Bedrock-runtime concerns that must be verified
 *                      via the website Playwright suite or against deployed infra.
 *                      The CSV remains the source of truth for manual coverage.
 *
 * Run only this file:
 *   npx jest test/chatbotProfessional.test.ts
 */

// ---- module mocks (must precede import of toolExecutor) -----------------

jest.mock("../lambda/src/handlers/chat/handlerAdapter", () => ({
  callHandlerInProcess: jest.fn(),
}));

jest.mock("../lambda/src/handlers/chat/sessionStore", () => ({
  setRecentSearchResults: jest.fn(async () => {}),
}));

// Preview rows now live in a dedicated DDB table (DentiPal-V5-PreviewGates)
// accessed via previewGateStore — see WS-2. The old session-row "pendingPreview"
// path is gone, so the mock surface here mirrors the new module boundary:
//   previewGateStore.putPreview   ← writes the row, returns a previewToken
//   previewGate.clearPreviewAfterConfirm ← burns the row after success
//   previewGate.verifyPreviewBeforeConfirm ← reads the row, checks token/payload
jest.mock("../lambda/src/handlers/chat/previewGateStore", () => ({
  putPreview: jest.fn(async () => "preview-tok-fixed"),
}));

jest.mock("../lambda/src/handlers/chat/previewGate", () => ({
  verifyPreviewBeforeConfirm: jest.fn(async () => ({ ok: true })),
  clearPreviewAfterConfirm: jest.fn(async () => {}),
}));

jest.mock("../lambda/src/handlers/browseJobPostings", () => ({
  runBrowseJobPostings: jest.fn(),
}));

jest.mock("../lambda/src/handlers/getJobInvitations", () => ({
  runGetJobInvitations: jest.fn(),
}));

// Allow forcing a "tool exists in schema but not in switch" for TC-CBP-055.
jest.mock("../lambda/src/handlers/chat/toolSchemas", () => {
  const actual = jest.requireActual("../lambda/src/handlers/chat/toolSchemas");
  return {
    ...actual,
    getToolDefinition: jest.fn((name: string) => {
      if (name === "ghost_tool") {
        return { name, bucket: "info", scope: "both", description: "ghost", inputSchema: {} };
      }
      return actual.getToolDefinition(name);
    }),
  };
});

// ---- imports under test --------------------------------------------------

import { executeTool, ToolCall, SessionContextSnapshot } from "../lambda/src/handlers/chat/toolExecutor";
import { AuthContext } from "../lambda/src/handlers/utils";
import { callHandlerInProcess } from "../lambda/src/handlers/chat/handlerAdapter";
import * as sessionStore from "../lambda/src/handlers/chat/sessionStore";
import * as previewGate from "../lambda/src/handlers/chat/previewGate";
import * as previewGateStore from "../lambda/src/handlers/chat/previewGateStore";
import { runBrowseJobPostings } from "../lambda/src/handlers/browseJobPostings";
import { runGetJobInvitations } from "../lambda/src/handlers/getJobInvitations";

const mockCall = callHandlerInProcess as jest.MockedFunction<typeof callHandlerInProcess>;
const mockBrowse = runBrowseJobPostings as unknown as jest.Mock;
const mockGetInvites = runGetJobInvitations as unknown as jest.Mock;
const mockPutPreview = previewGateStore.putPreview as jest.Mock;
const mockClearPreviewAfter = previewGate.clearPreviewAfterConfirm as jest.Mock;
const mockSetRecentResults = sessionStore.setRecentSearchResults as jest.Mock;
const mockVerifyGate = previewGate.verifyPreviewBeforeConfirm as jest.Mock;

// ---- helpers -------------------------------------------------------------

function mkAuth(over: Partial<AuthContext> = {}): AuthContext {
  return {
    userSub: "user-sub-1",
    userGroups: ["DentalHygienist"],
    userType: "Professional",
    email: "pro@example.com",
    ...over,
  } as AuthContext;
}

function mkCtx(over: Partial<SessionContextSnapshot> = {}): SessionContextSnapshot {
  return {
    agentType: "professional",
    home: { lat: 30.27, lng: -97.74, city: "Austin", state: "TX" },
    clinics: [],
    ...over,
  };
}

const CONN_ID = "ws-conn-1";

function run(toolName: string, input: Record<string, any> = {}, auth = mkAuth(), ctx?: SessionContextSnapshot) {
  const call: ToolCall = { toolName, input };
  return executeTool(call, auth, CONN_ID, ctx ?? mkCtx());
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyGate.mockImplementation(async () => ({ ok: true }));
  mockPutPreview.mockImplementation(async () => "preview-tok-fixed");
});

// =========================================================================
// Group 1 — Agent routing & session  (TC-CBP-001..004, 068)
// These live in chatMessage.ts / WebSocket layer / synthetic JWT, not in
// executeTool — verified by integration or by direct unit tests in
// dedicated files. Listed here as todo to keep 1:1 traceability with the CSV.
// =========================================================================

test.todo("TC-CBP-001: Chat widget mounts on professional pages — UI (Playwright e2e)");
test.todo("TC-CBP-002: Backend resolves canonical agent=professional — chatMessage.test.ts");
test.todo("TC-CBP-003: Context preamble injected once per session — chatMessage.test.ts");
test.todo("TC-CBP-004: WebSocket reconnect preserves session — integration");
test.todo("TC-CBP-068: synthetic token exp matches session TTL — handlerAdapter.test.ts");

// =========================================================================
// Group 2 — search_jobs_near_me (TC-CBP-005..015, 063..65)
// =========================================================================

describe("search_jobs_near_me", () => {
  test("TC-CBP-005: default radius=50 and home coords injected when not specified", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", {});
    const qs = mockCall.mock.calls[0][1].queryStringParameters!;
    expect(qs.radius).toBe("50");
    expect(qs.userLat).toBe("30.27");
    expect(qs.userLng).toBe("-97.74");
  });

  test("TC-CBP-006: display-name role normalized to dbValue", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { professionalRole: "Dental Hygienist" });
    expect(mockCall.mock.calls[0][1].queryStringParameters!.role).toBe("dental_hygienist");
  });

  test("TC-CBP-007: Cognito-group role normalized to dbValue", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { professionalRole: "DentalHygienist" });
    expect(mockCall.mock.calls[0][1].queryStringParameters!.role).toBe("dental_hygienist");
  });

  test("TC-CBP-008: unknown role silently dropped (no 400)", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    const res = await run("search_jobs_near_me", { professionalRole: "Astronaut" });
    expect(res.ok).toBe(true);
    expect(mockCall.mock.calls[0][1].queryStringParameters!.role).toBeUndefined();
  });

  test("TC-CBP-009: minRate/maxRate forwarded", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { minRate: 50, maxRate: 80 });
    const qs = mockCall.mock.calls[0][1].queryStringParameters!;
    expect(qs.minRate).toBe("50");
    expect(qs.maxRate).toBe("80");
  });

  test("TC-CBP-010: dateFrom/dateTo forwarded as start/end", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { dateFrom: "2026-05-20", dateTo: "2026-05-27" });
    const qs = mockCall.mock.calls[0][1].queryStringParameters!;
    expect(qs.start).toBe("2026-05-20");
    expect(qs.end).toBe("2026-05-27");
  });

  test("TC-CBP-011: limit clamped to 50", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { limit: 500 });
    expect(mockCall.mock.calls[0][1].queryStringParameters!.limit).toBe("50");
  });

  test("TC-CBP-012: default limit is 20 when not specified", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", {});
    expect(mockCall.mock.calls[0][1].queryStringParameters!.limit).toBe("20");
  });

  test("TC-CBP-013: Haversine fallback fills in distanceMiles when handler omits it", async () => {
    mockCall.mockResolvedValueOnce({
      status: 200,
      body: {
        jobs: [
          { jobId: "A", lat: 30.27, lng: -97.74 },          // ~0 mi
          { jobId: "B", lat: 30.50, lng: -97.74 },          // ~16 mi north
        ],
      },
    });
    const res = await run("search_jobs_near_me", {});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const sorted = res.data.jobPostings;
    expect(sorted[0].jobId).toBe("A");
    expect(typeof sorted[0].distanceMiles).toBe("number");
    expect(sorted[1].distanceMiles).toBeGreaterThan(sorted[0].distanceMiles);
  });

  test("TC-CBP-014: falls back to runBrowseJobPostings on canonical handler failure", async () => {
    mockCall.mockResolvedValueOnce({ status: 500, body: { message: "boom" } });
    mockBrowse.mockResolvedValueOnce({ status: 200, body: { jobs: [{ jobId: "X" }] } });
    const res = await run("search_jobs_near_me", {});
    expect(mockBrowse).toHaveBeenCalledTimes(1);
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-015: empty result rendered cleanly (jobPostings: [])", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    const res = await run("search_jobs_near_me", {});
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.jobPostings).toEqual([]);
    expect(res.data.totalCount).toBe(0);
  });

  test("TC-CBP-063: radiusMiles=0 falls back to default 50", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { radiusMiles: 0 });
    expect(mockCall.mock.calls[0][1].queryStringParameters!.radius).toBe("50");
  });

  test("TC-CBP-064: negative limit falls back to 20", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs: [] } });
    await run("search_jobs_near_me", { limit: -5 });
    expect(mockCall.mock.calls[0][1].queryStringParameters!.limit).toBe("20");
  });

  test("TC-CBP-065: setRecentSearchResults stores top 20", async () => {
    const jobs = Array.from({ length: 35 }, (_, i) => ({ jobId: `J${i}` }));
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobs } });
    await run("search_jobs_near_me", { limit: 50 });
    expect(mockSetRecentResults).toHaveBeenCalledTimes(1);
    const stored = mockSetRecentResults.mock.calls[0][2];
    expect(stored).toHaveLength(20);
  });
});

// =========================================================================
// Group 3 — Info lookups (TC-CBP-016..021)
// =========================================================================

describe("info lookups", () => {
  test("TC-CBP-016: get_job_details forwards jobId via pathParameters", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { jobId: "ABC123" } });
    const res = await run("get_job_details", { jobId: "ABC123" });
    expect(res.ok).toBe(true);
    expect(mockCall.mock.calls[0][1].pathParameters).toEqual({ jobId: "ABC123" });
  });

  test("TC-CBP-017: get_job_details missing jobId returns handler error gracefully", async () => {
    mockCall.mockResolvedValueOnce({ status: 400, body: { error: "jobId is required" } });
    const res = await run("get_job_details", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });

  test("TC-CBP-018: get_my_applications invokes getJobApplications", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { applications: [{ id: "1" }, { id: "2" }, { id: "3" }] } });
    const res = await run("get_my_applications");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.data.applications).toHaveLength(3);
  });

  test("TC-CBP-019: get_my_invitations routes through runGetJobInvitations", async () => {
    mockGetInvites.mockResolvedValueOnce({ status: 200, body: { invitations: [{ id: "i1" }, { id: "i2" }] } });
    const res = await run("get_my_invitations");
    expect(mockGetInvites).toHaveBeenCalledWith(expect.objectContaining({ userSub: "user-sub-1" }));
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-020: get_scheduled_shifts (pro path) filters to accepted/scheduled/hired/confirmed", async () => {
    mockCall.mockResolvedValueOnce({
      status: 200,
      body: {
        data: {
          applications: [
            { applicationId: "1", applicationStatus: "pending" },
            { applicationId: "2", applicationStatus: "accepted" },
            { applicationId: "3", applicationStatus: "scheduled" },
            { applicationId: "4", applicationStatus: "completed" },
            { applicationId: "5", applicationStatus: "declined" },
          ],
          totalCount: 5,
        },
      },
    });
    const res = await run("get_scheduled_shifts");
    if (!res.ok) throw new Error("expected ok");
    const apps = res.data.data.applications;
    expect(apps.map((a: any) => a.applicationId)).toEqual(["2", "3"]);
    expect(res.data.data.totalCount).toBe(2);
  });

  test("TC-CBP-021: get_completed_shifts (pro path) keeps only completed", async () => {
    mockCall.mockResolvedValueOnce({
      status: 200,
      body: {
        data: {
          applications: [
            { applicationId: "1", applicationStatus: "completed" },
            { applicationId: "2", applicationStatus: "completed" },
            { applicationId: "3", applicationStatus: "pending" },
          ],
          totalCount: 3,
        },
      },
    });
    const res = await run("get_completed_shifts");
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.data.applications).toHaveLength(2);
    expect(res.data.data.totalCount).toBe(2);
  });
});

// =========================================================================
// Group 4 — apply_to_job & legacy preview/confirm (TC-CBP-022..029)
// =========================================================================

describe("apply_to_job + legacy preview/confirm", () => {
  test("TC-CBP-022: single-shot apply forwards jobId/message/startDate/notes only", async () => {
    mockCall.mockResolvedValueOnce({ status: 201, body: { applicationId: "A1" } });
    const res = await run("apply_to_job", { jobId: "J1", message: "hi", startDate: "2026-06-01", notes: "n" });
    expect(res.ok).toBe(true);
    const body = mockCall.mock.calls[0][1].body;
    expect(body).toEqual({ jobId: "J1", message: "hi", startDate: "2026-06-01", notes: "n" });
  });

  test("TC-CBP-023: apply_to_job strips proposedRate (must not flip to negotiating)", async () => {
    mockCall.mockResolvedValueOnce({ status: 201, body: { applicationId: "A1" } });
    await run("apply_to_job", { jobId: "J1", proposedRate: 70 } as any);
    const body = mockCall.mock.calls[0][1].body;
    expect(body).not.toHaveProperty("proposedRate");
    expect(body).not.toHaveProperty("proposedSalaryMin");
    expect(body).not.toHaveProperty("proposedSalaryMax");
  });

  test("TC-CBP-024: apply_to_job missing jobId returns 400 without calling handler", async () => {
    const res = await run("apply_to_job", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(mockCall).not.toHaveBeenCalled();
  });

  test("TC-CBP-025: duplicate apply surfaces safeBodyToString error (not 'Error (undefined)')", async () => {
    mockCall.mockResolvedValueOnce({ status: 409, body: { message: "already applied" } });
    const res = await run("apply_to_job", { jobId: "J1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(res.error).toContain("already applied");
    expect(res.error).not.toContain("undefined");
  });

  test("TC-CBP-026: preview_apply_to_job returns a confirm_card with previewToken stored", async () => {
    const res = await run("preview_apply_to_job", { jobId: "J1" });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.kind).toBe("confirm_card");
    expect(res.data.previewToken).toBe("preview-tok-fixed");
    expect(res.data.confirmTool).toBe("confirm_apply_to_job");
    // Preview rows are now in PreviewGates (keyed by userSub+previewToken),
    // not on the ChatConnections row. Asserts the new shape: connectionId
    // is no longer part of the call.
    expect(mockPutPreview).toHaveBeenCalledWith({
      userSub: "user-sub-1",
      toolName: "preview_apply_to_job",
      payload: { jobId: "J1" },
    });
  });

  test("TC-CBP-027: confirm_apply_to_job posts after gate succeeds and clears preview", async () => {
    mockCall.mockResolvedValueOnce({ status: 201, body: { applicationId: "A1" } });
    const res = await run("confirm_apply_to_job", { previewToken: "preview-tok-fixed", jobId: "J1", message: "hi" });
    expect(res.ok).toBe(true);
    // New burn signature: (userSub, previewToken) — no connectionId.
    expect(mockClearPreviewAfter).toHaveBeenCalledWith("user-sub-1", "preview-tok-fixed");
  });

  test("TC-CBP-028: tampered confirm payload rejected by preview gate", async () => {
    mockVerifyGate.mockResolvedValueOnce({ ok: false, status: 409, reason: "Payload field 'rate' differs from previewed value" });
    const res = await run("confirm_apply_to_job", { previewToken: "preview-tok-fixed", jobId: "J1", rate: 999 });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(409);
    expect(mockCall).not.toHaveBeenCalled();
  });

  test("TC-CBP-029: expired preview rejected by gate", async () => {
    mockVerifyGate.mockResolvedValueOnce({ ok: false, status: 409, reason: "Preview expired; ask the user to re-confirm" });
    const res = await run("confirm_apply_to_job", { previewToken: "preview-tok-fixed", jobId: "J1" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/expired/i);
  });
});

// =========================================================================
// Group 5 — invitations (TC-CBP-030..032)
// =========================================================================

describe("invitations", () => {
  test("TC-CBP-030: respond_invitation accept forwards response='accepted'", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    const res = await run("respond_invitation", { invitationId: "INV-001", response: "accepted" });
    expect(res.ok).toBe(true);
    const opts = mockCall.mock.calls[0][1];
    expect(opts.pathParameters).toEqual({ invitationId: "INV-001" });
    expect(opts.body.response).toBe("accepted");
  });

  test("TC-CBP-031: respond_invitation decline forwards response='declined' and message", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("respond_invitation", { invitationId: "INV-001", response: "declined", message: "schedule conflict" });
    const opts = mockCall.mock.calls[0][1];
    expect(opts.body).toEqual({ response: "declined", message: "schedule conflict" });
  });

  test("TC-CBP-032: respond_invitation rejects 'negotiating' with route-to-negotiate hint", async () => {
    const res = await run("respond_invitation", { invitationId: "INV-001", response: "negotiating" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/preview_negotiate/);
    expect(mockCall).not.toHaveBeenCalled();
  });
});

// =========================================================================
// Group 6 — negotiations (TC-CBP-033..036, 039)
// =========================================================================

describe("negotiations", () => {
  test("TC-CBP-033: preview_negotiate counter_offer renders confirm_card", async () => {
    const res = await run("preview_negotiate", {
      applicationId: "APP-001",
      negotiationId: "NEG-001",
      response: "counter_offer",
      professionalCounterRate: 65,
    });
    if (!res.ok) throw new Error("expected ok");
    expect(res.data.kind).toBe("confirm_card");
  });

  test("TC-CBP-034: confirm_negotiate PUTs to respondToNegotiation with full payload", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_negotiate", {
      previewToken: "preview-tok-fixed",
      applicationId: "APP-001",
      negotiationId: "NEG-001",
      response: "counter_offer",
      professionalCounterRate: 65,
    });
    const opts = mockCall.mock.calls[0][1];
    expect(opts.method).toBe("PUT");
    expect(opts.pathParameters).toEqual({ applicationId: "APP-001", negotiationId: "NEG-001" });
    expect(opts.body.response).toBe("counter_offer");
    expect(opts.body.professionalCounterRate).toBe(65);
  });

  test("TC-CBP-035: negotiate accept clinic counter", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_negotiate", {
      previewToken: "preview-tok-fixed",
      applicationId: "APP-001",
      negotiationId: "NEG-001",
      response: "accepted",
    });
    expect(mockCall.mock.calls[0][1].body.response).toBe("accepted");
  });

  test("TC-CBP-036: negotiate decline clinic counter", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_negotiate", {
      previewToken: "preview-tok-fixed",
      applicationId: "APP-001",
      negotiationId: "NEG-001",
      response: "declined",
    });
    expect(mockCall.mock.calls[0][1].body.response).toBe("declined");
  });

  test("TC-CBP-039: get_my_negotiations forwards to getAllNegotiations-Prof", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { negotiations: [{ id: "n1" }, { id: "n2" }] } });
    const res = await run("get_my_negotiations");
    expect(res.ok).toBe(true);
    expect(mockCall.mock.calls[0][1].method).toBe("GET");
  });
});

// =========================================================================
// Group 7 — withdraw & attest (TC-CBP-037, 038, 040..042)
// =========================================================================

describe("withdraw & attest", () => {
  test("TC-CBP-037: preview_withdraw_application requires applicationId", async () => {
    const bad = await run("preview_withdraw_application", {});
    expect(bad.ok).toBe(false);
    const good = await run("preview_withdraw_application", { applicationId: "APP-001" });
    expect(good.ok).toBe(true);
  });

  test("TC-CBP-038: confirm_withdraw_application issues DELETE on applications/:id", async () => {
    mockCall.mockResolvedValueOnce({ status: 204, body: null });
    await run("confirm_withdraw_application", { previewToken: "preview-tok-fixed", applicationId: "APP-001" });
    const opts = mockCall.mock.calls[0][1];
    expect(opts.method).toBe("DELETE");
    expect(opts.pathParameters).toEqual({ applicationId: "APP-001" });
  });

  test("TC-CBP-040: preview_attest_completed_shift requires jobId/attestedHours/signedAt", async () => {
    const res = await run("preview_attest_completed_shift", {
      jobId: "JOB-9", attestedHours: 8, signedAt: "2026-05-13T17:00",
    });
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-041: attest with hours=0 rejected", async () => {
    const res = await run("preview_attest_completed_shift", {
      jobId: "JOB-9", attestedHours: 0, signedAt: "2026-05-13T17:00",
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/attestedHours/);
  });

  test("TC-CBP-042: confirm_attest_completed_shift PUTs to updateCompletedShifts", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_attest_completed_shift", {
      previewToken: "preview-tok-fixed", jobId: "JOB-9", attestedHours: 8, signedAt: "2026-05-13T17:00",
    });
    expect(mockCall.mock.calls[0][1].method).toBe("PUT");
  });
});

// =========================================================================
// Group 8 — profile, address, preferences, feedback, referral (TC-CBP-043..052)
// =========================================================================

describe("profile / address / prefs / feedback / referral", () => {
  test("TC-CBP-043: preview_update_my_profile accepts free-form input", async () => {
    const res = await run("preview_update_my_profile", { bio: "10 years experience" });
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-044: confirm_update_my_profile PUTs updateProfessionalProfile", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_update_my_profile", { previewToken: "preview-tok-fixed", bio: "10 yrs" });
    expect(mockCall.mock.calls[0][1].method).toBe("PUT");
  });

  test("TC-CBP-045: preview_update_home_address rejects partial address", async () => {
    const res = await run("preview_update_home_address", { addressLine1: "123 Main St" });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/addressLine1, city, state, pincode/);
  });

  test("TC-CBP-046: preview_update_home_address accepts full address (recompute is downstream)", async () => {
    const res = await run("preview_update_home_address", {
      addressLine1: "1 New St", city: "Austin", state: "TX", pincode: "78701",
    });
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-047: preview_update_notification_preferences accepts any toggles", async () => {
    const res = await run("preview_update_notification_preferences", { emailEnabled: false });
    expect(res.ok).toBe(true);
  });

  test("TC-CBP-048: confirm_update_notification_preferences PUTs the toggles", async () => {
    mockCall.mockResolvedValueOnce({ status: 200, body: { ok: true } });
    await run("confirm_update_notification_preferences", { previewToken: "preview-tok-fixed", emailEnabled: false });
    expect(mockCall.mock.calls[0][1].method).toBe("PUT");
  });

  test("TC-CBP-049: preview_submit_feedback requires feedback+type", async () => {
    const bad = await run("preview_submit_feedback", { feedback: "x" });
    expect(bad.ok).toBe(false);
    const good = await run("preview_submit_feedback", { feedback: "x", type: "bug" });
    expect(good.ok).toBe(true);
  });

  test("TC-CBP-050: confirm_submit_feedback POSTs to submitFeedback", async () => {
    mockCall.mockResolvedValueOnce({ status: 201, body: { id: "f1" } });
    await run("confirm_submit_feedback", { previewToken: "preview-tok-fixed", feedback: "x", type: "bug" });
    expect(mockCall.mock.calls[0][1].method).toBe("POST");
  });

  test("TC-CBP-051: preview_send_referral requires referredEmail+referredName", async () => {
    const bad = await run("preview_send_referral", { referredEmail: "x@y.com" });
    expect(bad.ok).toBe(false);
    const good = await run("preview_send_referral", { referredEmail: "x@y.com", referredName: "Jane" });
    expect(good.ok).toBe(true);
  });

  test("TC-CBP-052: confirm_send_referral POSTs to sendReferralInvite", async () => {
    mockCall.mockResolvedValueOnce({ status: 201, body: { ok: true } });
    await run("confirm_send_referral", { previewToken: "preview-tok-fixed", referredEmail: "x@y.com", referredName: "Jane" });
    expect(mockCall.mock.calls[0][1].method).toBe("POST");
  });
});

// =========================================================================
// Group 9 — Authorization & error handling (TC-CBP-053..057, 062, 069, 075)
// =========================================================================

describe("authorization & error handling", () => {
  test("TC-CBP-053 / TC-CBP-075: clinic-only tool dispatch still works at executor level — agent-schema gate is upstream", async () => {
    // Note: real authorization happens in the agent action-group config (the
    // professional Bedrock agent simply isn't given preview_post_temporary_job).
    // At the executor layer the tool is reachable, so this becomes a contract
    // test that the *validation* fires (missing required fields → 400).
    const res = await run("preview_post_temporary_job", {});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
  });

  test("TC-CBP-054: unknown tool returns 400 'Unknown tool'", async () => {
    const res = await run("do_evil_thing");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(400);
    expect(res.error).toMatch(/Unknown tool/);
  });

  test("TC-CBP-055: unwired tool (in schema, not in switch) returns 501", async () => {
    const res = await run("ghost_tool");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(501);
    expect(res.error).toMatch(/not wired up/);
  });

  test("TC-CBP-056: handler exception caught and returned as 500", async () => {
    mockCall.mockRejectedValueOnce(new Error("boom"));
    const res = await run("get_my_applications");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.status).toBe(500);
    expect(res.error).toBe("boom");
  });

  test("TC-CBP-057: 4xx with undefined body avoids 'Error (undefined)'", async () => {
    mockCall.mockResolvedValueOnce({ status: 400, body: undefined });
    const res = await run("get_my_applications");
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toBe("Handler returned 400 with no body");
    expect(res.error).not.toContain("undefined");
  });

  test("TC-CBP-062: pro path ignores clinicId param for get_scheduled_shifts", async () => {
    mockCall.mockResolvedValueOnce({
      status: 200,
      body: { data: { applications: [{ applicationStatus: "accepted" }], totalCount: 1 } },
    });
    await run("get_scheduled_shifts", { clinicId: "SOMEONE-ELSES-CLINIC" }, mkAuth({ userType: "Professional" }));
    // Should call getJobApplications (no pathParameters), NOT getScheduledShifts (with clinicId)
    expect(mockCall.mock.calls[0][1].pathParameters).toBeUndefined();
  });

  test("TC-CBP-069: userType case-insensitive — 'PROFESSIONAL' treated as pro", async () => {
    mockCall.mockResolvedValueOnce({
      status: 200,
      body: { data: { applications: [{ applicationStatus: "accepted" }], totalCount: 1 } },
    });
    await run("get_scheduled_shifts", { clinicId: "X" }, mkAuth({ userType: "PROFESSIONAL" }));
    expect(mockCall.mock.calls[0][1].pathParameters).toBeUndefined();
  });
});

// =========================================================================
// Group 10 — Security / UI / WebSocket  (TC-CBP-058..061, 066..67, 070..74)
// All UI- or runtime-level — not reachable from executeTool. Tracked here for
// 1:1 traceability with the CSV; verify in Playwright / chatMessage.test.ts.
// =========================================================================

test.todo("TC-CBP-058: XSS in chat input rendered as text — Playwright (chat-widget.spec.ts)");
test.todo("TC-CBP-059: XSS in tool result rendered as text — Playwright");
test.todo("TC-CBP-060: No JWT leak to browser console — Playwright security suite");
test.todo("TC-CBP-061: Synthetic token never egresses Lambda — runtime invariant, manual review");
test.todo("TC-CBP-066: Bedrock 5xx returns user-friendly retry — chatMessage.test.ts");
test.todo("TC-CBP-067: 10k-char message bounded — chatMessage.test.ts");
test.todo("TC-CBP-070: Mobile widget layout 375×812 — Playwright");
test.todo("TC-CBP-071: Send button aria-label — Playwright a11y");
test.todo("TC-CBP-072: Enter sends, Shift+Enter newline — Playwright");
test.todo("TC-CBP-073: Chat history persists across widget close/open — Playwright");
test.todo("TC-CBP-074: Composer disabled when socket closed — Playwright");
