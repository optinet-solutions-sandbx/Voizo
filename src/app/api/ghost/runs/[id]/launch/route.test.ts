import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("../../../../../../lib/supabaseServer", () => ({ supabaseAdmin: {} }));
vi.mock("../../../../../../lib/ghost/ghostRunData", () => ({
  getGhostRun: vi.fn(),
  updateGhostRun: vi.fn(),
}));
vi.mock("../../../../../../lib/ghost/ghostScrub", () => ({ scrubGhostPhones: vi.fn() }));
vi.mock("../../../../../../lib/ghost/launchGhostRun", () => ({ launchGhostRun: vi.fn() }));

import { POST } from "./route";
import { getGhostRun, updateGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { scrubGhostPhones } from "../../../../../../lib/ghost/ghostScrub";
import { launchGhostRun } from "../../../../../../lib/ghost/launchGhostRun";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };
function req(body: unknown, headers: Record<string, string> = SAME): NextRequest {
  return { headers: new Headers(headers), json: async () => body } as unknown as NextRequest;
}
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });
const liveWindow = [{ day: "mon", start: "12:00", end: "17:00" }];

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  process.env.VAPI_PRIVATE_KEY = "k";
  (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({
    id: "r1", name: "Run", tier: "test", base_assistant_id: "base_1", operator: "op@x.com", status: "ready",
  });
  (scrubGhostPhones as ReturnType<typeof vi.fn>).mockResolvedValue({
    uploaded: 2, suppressed: 0, net: ["+15551110000", "+15552220000"], suppressedDnc: 0, suppressedRecent: 0,
  });
  (updateGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1" });
  (launchGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, campaignId: "camp1", slotIndex: 0, numberCount: 2 });
});

describe("POST /api/ghost/runs/[id]/launch", () => {
  it("404s when disabled", async () => {
    delete process.env.GHOST_PORTAL_ENABLED;
    const res = await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(res.status).toBe(404);
  });

  it("403s cross-origin", async () => {
    const res = await POST(req({ phones: ["+15551110000"] }, { origin: "http://evil.com", host: "localhost:3000" }), ctx());
    expect(res.status).toBe(403);
  });

  it("404s when the run does not exist", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(res.status).toBe(404);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("409s when the run is already launched (no double-launch / double-billing)", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", tier: "test", status: "launched" });
    const res = await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(res.status).toBe(409);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("400s a live run with no call window (re-enforced at launch)", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "L", tier: "live", base_assistant_id: "b", operator: "o", status: "ready" });
    const res = await POST(req({ phones: ["+15551110000"], callWindows: [] }), ctx());
    expect(res.status).toBe(400);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("400s a live run whose call windows are structurally malformed (wrong-hours dialing guard)", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "L", tier: "live", base_assistant_id: "b", operator: "o", status: "ready" });
    const res = await POST(req({ phones: ["+15551110000"], callWindows: [{ day: "funday", start: "9", end: "25:99" }] }), ctx());
    expect(res.status).toBe(400);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("422s when every number is suppressed (nothing left to dial) — launch NOT called", async () => {
    (scrubGhostPhones as ReturnType<typeof vi.fn>).mockResolvedValue({ uploaded: 2, suppressed: 2, net: [], suppressedDnc: 2, suppressedRecent: 0 });
    const res = await POST(req({ phones: ["+15551110000", "+15552220000"] }), ctx());
    expect(res.status).toBe(422);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("500s when the VAPI key is missing (loud, not silent)", async () => {
    delete process.env.VAPI_PRIVATE_KEY;
    const res = await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(res.status).toBe(500);
    expect(launchGhostRun).not.toHaveBeenCalled();
  });

  it("re-scrubs server-side and launches with the NET list (test tier → empty windows)", async () => {
    const res = await POST(req({ phones: ["+15551110000", "+15552220000", "+15553330000"], timezone: "Asia/Manila" }), ctx());
    expect(res.status).toBe(200);
    // never trusts the client: scrub runs on the submitted phones
    expect(scrubGhostPhones).toHaveBeenCalledWith(expect.anything(), ["+15551110000", "+15552220000", "+15553330000"], { applyRecency: false });
    expect(launchGhostRun).toHaveBeenCalledWith(
      expect.objectContaining({
        numbers: ["+15551110000", "+15552220000"], // the scrubbed net, not the raw input
        callWindows: [],
        run: expect.objectContaining({ id: "r1", tier: "test", base_assistant_id: "base_1", operator: "op@x.com" }),
      }),
    );
    expect(updateGhostRun).toHaveBeenLastCalledWith(
      expect.anything(), "r1",
      expect.objectContaining({ status: "launched", campaign_id: "camp1" }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, campaignId: "camp1", numberCount: 2 });
  });

  it("passes the live call window through and applies recency", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", name: "L", tier: "live", base_assistant_id: "b", operator: "o", status: "ready" });
    await POST(req({ phones: ["+15551110000"], timezone: "Asia/Manila", callWindows: liveWindow }), ctx());
    expect(scrubGhostPhones).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { applyRecency: true });
    expect(launchGhostRun).toHaveBeenCalledWith(expect.objectContaining({ callWindows: liveWindow }));
  });

  it("marks the run failed (with reason) when launch fails, surfacing the launch status", async () => {
    (launchGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: false, status: 503, error: "No spare SIP capacity" });
    const res = await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(res.status).toBe(503);
    expect(updateGhostRun).toHaveBeenLastCalledWith(
      expect.anything(), "r1",
      expect.objectContaining({ status: "failed", fail_reason: "No spare SIP capacity" }),
    );
  });
});
