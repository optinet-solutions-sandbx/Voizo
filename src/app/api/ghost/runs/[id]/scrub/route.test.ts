import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("../../../../../../lib/supabaseServer", () => ({ supabaseAdmin: {} }));
vi.mock("../../../../../../lib/ghost/ghostRunData", () => ({
  getGhostRun: vi.fn(),
  updateGhostRun: vi.fn(),
}));
vi.mock("../../../../../../lib/ghost/ghostScrub", () => ({ scrubGhostPhones: vi.fn() }));

import { POST } from "./route";
import { getGhostRun, updateGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { scrubGhostPhones } from "../../../../../../lib/ghost/ghostScrub";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };
function req(body: unknown, headers: Record<string, string> = SAME): NextRequest {
  return { headers: new Headers(headers), json: async () => body } as unknown as NextRequest;
}
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", tier: "test", status: "draft" });
  (scrubGhostPhones as ReturnType<typeof vi.fn>).mockResolvedValue({
    uploaded: 3, suppressed: 1, net: ["+15551110000", "+15552220000"], suppressedDnc: 1, suppressedRecent: 0,
  });
  (updateGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", status: "ready" });
});

describe("POST /api/ghost/runs/[id]/scrub", () => {
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
    const res = await POST(req({ phones: ["+15551110000"] }), ctx("nope"));
    expect(res.status).toBe(404);
  });

  it("400s when no phones are provided", async () => {
    const res = await POST(req({ phones: [] }), ctx());
    expect(res.status).toBe(400);
    expect(scrubGhostPhones).not.toHaveBeenCalled();
  });

  it("scrubs WITHOUT recency for a test run, updates counts + status=ready", async () => {
    const res = await POST(req({ phones: ["+15551110000", "+15552220000", "+15553330000"] }), ctx());
    expect(res.status).toBe(200);
    expect(scrubGhostPhones).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { applyRecency: false });
    expect(updateGhostRun).toHaveBeenCalledWith(
      expect.anything(), "r1",
      expect.objectContaining({ status: "ready", scrubbed_count: 2, suppressed_count: 1 }),
    );
    const body = await res.json();
    expect(body).toMatchObject({ uploaded: 3, suppressed: 1, net: 2, suppressedDnc: 1 });
  });

  it("applies recency for a LIVE run", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", tier: "live", status: "draft" });
    await POST(req({ phones: ["+15551110000"] }), ctx());
    expect(scrubGhostPhones).toHaveBeenCalledWith(expect.anything(), expect.any(Array), { applyRecency: true });
  });
});
