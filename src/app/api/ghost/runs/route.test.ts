import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Relative mocks (vitest does not resolve "@/"). Mock the env-throwing service-role
// singleton + the data layer; use the REAL parser/config/csrf so guard behavior is
// exercised end-to-end. ghostConfig reads process.env lazily, so env set per test.
vi.mock("../../../../lib/supabaseServer", () => ({ supabaseAdmin: {} }));
vi.mock("../../../../lib/ghost/ghostRunData", () => ({
  createGhostRun: vi.fn(),
  listGhostRuns: vi.fn(),
}));

import { POST, GET } from "./route";
import { createGhostRun, listGhostRuns } from "../../../../lib/ghost/ghostRunData";

const SAME = { origin: "http://localhost:3000", host: "localhost:3000" };

function req(body: unknown, headers: Record<string, string> = SAME): NextRequest {
  return { headers: new Headers(headers), json: async () => body } as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.GHOST_PORTAL_ENABLED = "true";
  delete process.env.GHOST_MAX_TARGETS;
  (createGhostRun as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "r1", slug: "abcd1234", status: "draft" });
});

describe("POST /api/ghost/runs", () => {
  it("404s when the portal is disabled", async () => {
    delete process.env.GHOST_PORTAL_ENABLED;
    const res = await POST(req({ name: "x", tier: "test", base_assistant_id: "b", format: "paste", raw: "+15551110000" }));
    expect(res.status).toBe(404);
  });

  it("403s a cross-origin POST", async () => {
    const res = await POST(req({ name: "x", tier: "test", base_assistant_id: "b", format: "paste", raw: "+15551110000" }, { origin: "http://evil.com", host: "localhost:3000" }));
    expect(res.status).toBe(403);
  });

  it("400s a live run with no call window", async () => {
    const res = await POST(req({ name: "x", tier: "live", base_assistant_id: "b", format: "paste", raw: "+15551110000", callWindows: [] }));
    expect(res.status).toBe(400);
    expect(createGhostRun).not.toHaveBeenCalled();
  });

  it("allows a live run WITH a call window", async () => {
    const res = await POST(req({ name: "x", tier: "live", base_assistant_id: "b", format: "paste", raw: "+15551110000", callWindows: [{ day: "mon", start: "12:00", end: "17:00" }] }));
    expect(res.status).toBe(201);
    expect(createGhostRun).toHaveBeenCalled();
  });

  it("413s when targets exceed the hard cap", async () => {
    process.env.GHOST_MAX_TARGETS = "2";
    const res = await POST(req({ name: "x", tier: "test", base_assistant_id: "b", format: "paste", raw: "+15551110000,+15552220000,+15553330000" }));
    expect(res.status).toBe(413);
    expect(createGhostRun).not.toHaveBeenCalled();
  });

  it("400s when no valid phone parses from the upload", async () => {
    const res = await POST(req({ name: "x", tier: "test", base_assistant_id: "b", format: "paste", raw: "not-a-number" }));
    expect(res.status).toBe(400);
  });

  it("400s when required fields are missing", async () => {
    const res = await POST(req({ tier: "test", base_assistant_id: "b", format: "paste", raw: "+15551110000" }));
    expect(res.status).toBe(400);
  });

  it("creates the run and echoes parsed targets (test tier, happy path)", async () => {
    const res = await POST(req({ name: "My Run", tier: "test", base_assistant_id: "base_1", format: "paste", raw: "+15551110000, +15552220000, +15551110000" }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.run).toMatchObject({ id: "r1", slug: "abcd1234" });
    expect(body.targets).toEqual(["+15551110000", "+15552220000"]); // deduped
    expect(createGhostRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: "My Run", tier: "test", baseAssistantId: "base_1", uploadedCount: 2 }),
    );
  });

  it("surfaces a warning above the soft threshold but still creates", async () => {
    process.env.GHOST_MAX_TARGETS = "5000";
    const raw = Array.from({ length: 501 }, (_, i) => `+1555${String(1000000 + i)}`).join(",");
    const res = await POST(req({ name: "Big", tier: "test", base_assistant_id: "b", format: "paste", raw }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.warning).toBeTruthy();
  });
});

describe("GET /api/ghost/runs", () => {
  it("404s when disabled", async () => {
    delete process.env.GHOST_PORTAL_ENABLED;
    const res = await GET(req(null));
    expect(res.status).toBe(404);
  });

  it("lists runs when enabled", async () => {
    (listGhostRuns as ReturnType<typeof vi.fn>).mockResolvedValue([{ id: "r1" }, { id: "r2" }]);
    const res = await GET(req(null));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.runs).toHaveLength(2);
  });
});
