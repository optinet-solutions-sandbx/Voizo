import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GET } from "./route";

const realFetch = global.fetch;

beforeEach(() => {
  process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID = "asst-1";
  process.env.VAPI_PRIVATE_KEY = "key-1";
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("GET /api/vapi-assistants — the lab's deliberately-single assistant list", () => {
  it("returns exactly the designated script base, as the bare array the lab panel expects", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "asst-1", name: "Val - Voice Agent" }),
    }) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ id: "asst-1", name: "Val - Voice Agent" }]);
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.vapi.ai/assistant/asst-1",
      expect.objectContaining({ headers: { Authorization: "Bearer key-1" } }),
    );
  });

  it("500s with a clear error when VAPI_SCRIPT_BASE_ASSISTANT_ID is not set", async () => {
    delete process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID;
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/VAPI_SCRIPT_BASE_ASSISTANT_ID/);
  });

  it("502s when Vapi rejects the lookup", async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "unauthorized",
    }) as unknown as typeof fetch;

    const res = await GET();
    expect(res.status).toBe(502);
  });
});
