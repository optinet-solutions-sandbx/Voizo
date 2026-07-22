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
}));
vi.mock("../../../../lib/scriptEngine/lab-briefing", () => ({
  compileStageBriefing: vi.fn(async () => null),
  compileStandingAnswers: vi.fn(async () => null),
}));
vi.mock("../../../../lib/scriptEngine/lab-flow", () => ({
  findEntryNode: () => null,
}));

import { POST } from "./route";

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
});
