import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

vi.mock("../../../../../../lib/supabaseServer", () => ({ supabaseAdmin: {} }));
vi.mock("../../../../../../lib/ghost/ghostRunData", () => ({ getGhostRun: vi.fn() }));
vi.mock("../../../../../../lib/ghost/ghostLabelData", () => ({ listGhostRunCalls: vi.fn() }));

import { GET } from "./route";
import { getGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { listGhostRunCalls } from "../../../../../../lib/ghost/ghostLabelData";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };
function req(headers: Record<string, string> = SAME): NextRequest {
  return { headers: new Headers(headers) } as unknown as NextRequest;
}
const ctx = (id = "r1") => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", campaign_id: "camp1", status: "launched" });
  (listGhostRunCalls as ReturnType<typeof vi.fn>).mockResolvedValue([{ callId: "c1", yourLabel: null }]);
});

describe("GET /api/ghost/runs/[id]/calls", () => {
  it("404s when disabled", async () => {
    delete process.env.GHOST_PORTAL_ENABLED;
    const res = await GET(req(), ctx());
    expect(res.status).toBe(404);
  });

  it("403s cross-origin", async () => {
    const res = await GET(req({ origin: "http://evil.com", host: "localhost:3000" }), ctx());
    expect(res.status).toBe(403);
  });

  it("404s when the run does not exist", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    const res = await GET(req(), ctx("nope"));
    expect(res.status).toBe(404);
    expect(listGhostRunCalls).not.toHaveBeenCalled();
  });

  it("returns empty calls when the run is not launched yet (no campaign)", async () => {
    (getGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", campaign_id: null, status: "ready" });
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ calls: [] });
    expect(listGhostRunCalls).not.toHaveBeenCalled();
  });

  it("returns the run's labelable calls when launched", async () => {
    const res = await GET(req(), ctx());
    expect(res.status).toBe(200);
    expect(listGhostRunCalls).toHaveBeenCalledWith(expect.anything(), "camp1", expect.any(String));
    const body = await res.json();
    expect(body.calls).toHaveLength(1);
  });
});
