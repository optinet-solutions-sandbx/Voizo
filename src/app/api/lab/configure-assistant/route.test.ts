import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../../../../lib/scriptEngine/lab-tools", () => ({
  LAB_TOOLS: [{ type: "function", function: { name: "lookup_answer" } }],
  LAB_OPERATING_RULES: "RULES",
  DEFAULT_SHORT_PROMPT: "PERSONA",
}));
vi.mock("../../../../lib/scriptEngine/lab-db", () => ({
  getLabSettings: vi.fn(async () => null),
  saveLabSettings: vi.fn(async () => {}),
  listHandlers: vi.fn(async () => []),
  getScriptGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
  getScript: vi.fn(async () => null),
}));
vi.mock("../../../../lib/scriptEngine/lab-briefing", () => ({
  compileStageBriefing: vi.fn(async () => null),
  compileStandingAnswers: vi.fn(async () => null),
}));
vi.mock("../../../../lib/scriptEngine/lab-flow", () => ({
  findEntryNode: () => null,
}));

import { POST } from "./route";
import * as labDb from "../../../../lib/scriptEngine/lab-db";

const realFetch = global.fetch;

function mockVapi() {
  const calls: { url: string; init?: RequestInit }[] = [];
  global.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: true,
      json: async () => ({ name: "Val - Voice Agent", model: { messages: [] }, transcriber: { provider: "deepgram" } }),
      text: async () => "",
    };
  }) as unknown as typeof fetch;
  return calls;
}

function req(body: unknown): Request {
  return new Request("http://localhost/api/lab/configure-assistant", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPI_PRIVATE_KEY = "key-1";
  process.env.VAPI_SCRIPT_BASE_ASSISTANT_ID = "asst-1";
  process.env.VAPI_WEBHOOK_URL = "https://example.test/api/webhooks/vapi/end-of-call";
  delete process.env.VAPI_WEBHOOK_SECRET;
  delete process.env.LAB_WEBHOOK_BASE_URL;
});

afterEach(() => {
  global.fetch = realFetch;
});

describe("POST /api/lab/configure-assistant", () => {
  it("403s any assistant other than the designated script base, before touching Vapi", async () => {
    const calls = mockVapi();
    const res = await POST(req({ assistantId: "some-live-clone" }));
    expect(res.status).toBe(403);
    expect(calls.length).toBe(0);
  });

  it("always provisions server.secret (falls back to the private key, mirroring the webhook gate)", async () => {
    // The lab webhook gate rejects whenever VAPI_WEBHOOK_SECRET *or*
    // VAPI_PRIVATE_KEY is set — the private key always is. If configure only
    // set the secret when VAPI_WEBHOOK_SECRET exists, an env without it would
    // provision a secretless assistant and every event would 403 silently.
    const calls = mockVapi();
    const res = await POST(req({ assistantId: "asst-1" }));
    expect(res.status).toBe(200);

    const vapiPatch = calls.find((c) => c.init?.method === "PATCH");
    expect(vapiPatch).toBeDefined();
    const body = JSON.parse(String(vapiPatch!.init!.body));
    expect(body.server).toEqual({
      url: "https://example.test/api/lab/webhook", // origin of VAPI_WEBHOOK_URL — the ladder's rung 3
      timeoutSeconds: 20,
      secret: "key-1",
    });
  });

  // ── VOZ-188: persona ladder — the active script's own persona first ──
  describe("persona ladder (VOZ-188)", () => {
    afterEach(() => {
      // listHandlers gets a persistent impl below; restore the factory default
      // so tests outside this block keep seeing no handlers.
      vi.mocked(labDb.listHandlers).mockImplementation(async () => []);
    });

    function systemPromptOf(calls: { url: string; init?: RequestInit }[]): string {
      const patch = calls.find((c) => c.init?.method === "PATCH");
      const body = JSON.parse(String(patch!.init!.body));
      return (body.model.messages as { role: string; content: string }[]).find((m) => m.role === "system")!.content;
    }

    it("the active script's persona outranks the Playbook identity scenario", async () => {
      vi.mocked(labDb.getLabSettings).mockResolvedValueOnce({ active_script_id: "s1" } as never);
      vi.mocked(labDb.getScript).mockResolvedValueOnce({ id: "s1", persona: "SCRIPT-PERSONA" } as never);
      vi.mocked(labDb.listHandlers).mockImplementation(
        async () => [{ intent_key: "identity", enabled: true, response_template: "IDENTITY-PERSONA" }] as never,
      );
      const calls = mockVapi();
      const res = await POST(req({ assistantId: "asst-1" }));
      expect(res.status).toBe(200);
      const sys = systemPromptOf(calls);
      expect(sys).toContain("SCRIPT-PERSONA");
      expect(sys).not.toContain("IDENTITY-PERSONA");
    });

    it("a script with a blank persona falls through to the identity scenario (legacy behavior)", async () => {
      vi.mocked(labDb.getLabSettings).mockResolvedValueOnce(
        { active_script_id: "s1", short_prompt: "GLOBAL-FALLBACK" } as never,
      );
      vi.mocked(labDb.getScript).mockResolvedValueOnce({ id: "s1", persona: "   " } as never);
      vi.mocked(labDb.listHandlers).mockImplementation(
        async () => [{ intent_key: "identity", enabled: true, response_template: "IDENTITY-PERSONA" }] as never,
      );
      const calls = mockVapi();
      const res = await POST(req({ assistantId: "asst-1" }));
      expect(res.status).toBe(200);
      const sys = systemPromptOf(calls);
      expect(sys).toContain("IDENTITY-PERSONA");
      expect(sys).not.toContain("GLOBAL-FALLBACK");
    });
  });
});
