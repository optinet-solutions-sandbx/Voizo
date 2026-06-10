import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("../../../../../../../../lib/supabaseServer", () => ({ supabaseAdmin: {} }));
vi.mock("../../../../../../../../lib/ghost/ghostRunData", () => ({ getGhostRun: vi.fn() }));
vi.mock("../../../../../../../../lib/ghost/ghostLabelData", () => ({
  callBelongsToCampaign: vi.fn(),
  upsertGhostLabel: vi.fn(),
}));

import { POST } from "./route";
import { getGhostRun } from "../../../../../../../../lib/ghost/ghostRunData";
import { callBelongsToCampaign, upsertGhostLabel } from "../../../../../../../../lib/ghost/ghostLabelData";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };
function req(body: unknown, headers: Record<string, string> = SAME): NextRequest {
  return { headers: new Headers(headers), json: async () => body } as unknown as NextRequest;
}
const ctx = (id = "r1", callId = "c1") => ({ params: Promise.resolve({ id, callId }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", campaign_id: "camp1", status: "launched" });
  (callBelongsToCampaign as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  (upsertGhostLabel as ReturnType<typeof vi.fn>).mockResolvedValue({ call_id: "c1", verdict: "good", reason: "clean" });
});

describe("POST /api/ghost/runs/[id]/calls/[callId]/label", () => {
  it("404s when disabled", async () => {
    delete process.env.GHOST_PORTAL_ENABLED;
    const res = await POST(req({ verdict: "good" }), ctx());
    expect(res.status).toBe(404);
  });

  it("403s cross-origin", async () => {
    const res = await POST(req({ verdict: "good" }, { origin: "http://evil.com", host: "localhost:3000" }), ctx());
    expect(res.status).toBe(403);
  });

  it("400s an invalid verdict", async () => {
    const res = await POST(req({ verdict: "amazing" }), ctx());
    expect(res.status).toBe(400);
    expect(upsertGhostLabel).not.toHaveBeenCalled();
  });

  it("404s when the run does not exist", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(req({ verdict: "good" }), ctx());
    expect(res.status).toBe(404);
    expect(upsertGhostLabel).not.toHaveBeenCalled();
  });

  it("404s (never reveals) when the call is not in this run's campaign", async () => {
    (callBelongsToCampaign as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const res = await POST(req({ verdict: "bad" }), ctx("r1", "c-other"));
    expect(res.status).toBe(404);
    expect(upsertGhostLabel).not.toHaveBeenCalled();
  });

  it("upserts the label (labeled_by = operator) and returns it on the happy path", async () => {
    const res = await POST(req({ verdict: "good", reason: "clean" }), ctx());
    expect(res.status).toBe(200);
    expect(callBelongsToCampaign).toHaveBeenCalledWith(expect.anything(), "c1", "camp1");
    expect(upsertGhostLabel).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ callId: "c1", verdict: "good", reason: "clean", labeledBy: expect.any(String) }),
    );
    const body = await res.json();
    expect(body.label).toMatchObject({ verdict: "good" });
  });
});
