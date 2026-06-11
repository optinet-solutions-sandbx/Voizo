import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// COMPLIANCE SUITE — proves the NON-NEGOTIABLE DNC gate end-to-end through the
// launch route using the REAL scrub (ghostScrub is NOT mocked here). A
// DNC-suppressed number in the uploaded list must never reach the dialed set,
// regardless of what the client submits. Only the env-throwing service-role
// singleton + the Vapi/DB orchestration (launchGhostRun) are mocked.

// Fake supabase covering the dncSuppressedSet chain (.from().select().in() and
// .from().select().eq().in()). Thenable builder resolves to the table's rows.
function fakeSupabaseWithDnc(suppressed: string[]) {
  return {
    from(table: string) {
      const rows =
        table === "suppression_list" ? suppressed.map((p) => ({ phone_e164: p }))
        : table === "do_not_call" ? [] // none in do_not_call for this fixture
        : [];
      const result = { data: rows, error: null };
      const b: any = { select: () => b, eq: () => b, in: () => b, gt: () => b, then: (r: (v: typeof result) => void) => r(result) };
      return b;
    },
  } as any;
}

vi.mock("../../../../../../lib/supabaseServer", () => ({ supabaseAdmin: fakeSupabaseWithDnc(["+15559990000"]) }));
vi.mock("../../../../../../lib/ghost/ghostRunData", () => ({
  getGhostRun: vi.fn(),
  updateGhostRun: vi.fn(),
}));
// NOTE: ghostScrub is intentionally NOT mocked — the real DNC gate runs.
vi.mock("../../../../../../lib/ghost/launchGhostRun", () => ({ launchGhostRun: vi.fn() }));

import { POST } from "./route";
import { getGhostRun, updateGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { launchGhostRun } from "../../../../../../lib/ghost/launchGhostRun";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };
function req(body: unknown): NextRequest {
  return { headers: new Headers(SAME), json: async () => body } as unknown as NextRequest;
}
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

const DNC = "+15559990000"; // present in suppression_list (fakeSupabaseWithDnc)
const CLEAN_A = "+15551110000";
const CLEAN_B = "+15552220000";

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  process.env.VAPI_PRIVATE_KEY = "k";
  (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "r1", name: "Compliance", tier: "test", base_assistant_id: "base_1", operator: "op", status: "ready",
  });
  (updateGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (launchGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, campaignId: "camp1", slotIndex: 0, numberCount: 2 });
});

describe("GhostPortal compliance — DNC is enforced at launch (real scrub)", () => {
  it("excludes a DNC-suppressed number from the dialed set even when the client submits it", async () => {
    const res = await POST(req({ phones: [CLEAN_A, DNC, CLEAN_B] }), ctx());
    expect(res.status).toBe(200);

    // The DNC number reached the server in the request body, but the REAL scrub
    // removed it before launchGhostRun — it can never be dialed.
    expect(launchGhostRun).toHaveBeenCalledTimes(1);
    const passed = (launchGhostRun as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(passed.numbers).toEqual([CLEAN_A, CLEAN_B]);
    expect(passed.numbers).not.toContain(DNC);
  });

  it("returns 422 and never launches when EVERY uploaded number is on the DNC list", async () => {
    const res = await POST(req({ phones: [DNC] }), ctx());
    expect(res.status).toBe(422);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });
});
