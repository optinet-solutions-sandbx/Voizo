import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { GET, PATCH } from "./route";

const realFetch = global.fetch;

/** Captures the Vapi PATCH body while mocking the GET-then-PATCH sequence. */
function mockVapi(assistant: Record<string, unknown>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (!init?.method || init.method === "GET") {
      return { ok: true, json: async () => assistant, text: async () => "" };
    }
    return { ok: true, json: async () => ({}), text: async () => "" };
  }) as unknown as typeof fetch;
  return calls;
}

function patchReq(body: unknown): Request {
  return new Request("http://localhost/api/vapi-assistant", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID = "asst-1";
  process.env.VAPI_PRIVATE_KEY = "key-1";
});

afterEach(() => {
  global.fetch = realFetch;
  vi.restoreAllMocks();
});

describe("PATCH /api/vapi-assistant — voice merge (clone-drift guard)", () => {
  it("merges a pushed voice over the assistant's tuned voice knobs instead of replacing wholesale", async () => {
    // The documented 2026-05 incident: wholesale voice replacement dropped
    // stability/similarityBoost/SSML and campaign clones inherited the bare
    // object. The lab pushes {provider, voiceId} — everything else must survive.
    const calls = mockVapi({
      model: { messages: [] },
      voice: {
        provider: "11labs",
        voiceId: "old-voice",
        model: "eleven_turbo_v2_5",
        stability: 0.85,
        similarityBoost: 0.9,
        enableSsmlParsing: true,
      },
    });

    const res = await PATCH(patchReq({ assistantId: "asst-1", voice: { provider: "11labs", voiceId: "new-voice" } }));
    expect(res.status).toBe(200);

    const vapiPatch = calls.find((c) => c.init?.method === "PATCH");
    expect(vapiPatch).toBeDefined();
    const body = JSON.parse(String(vapiPatch!.init!.body));
    expect(body.voice).toEqual({
      provider: "11labs",
      voiceId: "new-voice",
      model: "eleven_turbo_v2_5",
      stability: 0.85,
      similarityBoost: 0.9,
      enableSsmlParsing: true,
    });
  });
});

describe("/api/vapi-assistant — pinned to the designated script base", () => {
  it("403s a PATCH naming any other assistant (e.g. a live campaign clone)", async () => {
    const calls = mockVapi({ model: { messages: [] } });
    const res = await PATCH(patchReq({ assistantId: "some-live-clone", systemPrompt: "pwn" }));
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0); // never reached Vapi
  });

  it("403s a GET naming any other assistant", async () => {
    const calls = mockVapi({ model: { messages: [] } });
    const res = await GET(new Request("http://localhost/api/vapi-assistant?assistantId=other"));
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });
});
