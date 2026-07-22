import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../../lib/scriptEngine/handleWebhook", () => ({
  handleWebhook: vi.fn(
    async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  ),
}));

import { POST } from "./route";
import { handleWebhook } from "../../../../lib/scriptEngine/handleWebhook";

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/lab/webhook", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ message: { type: "transcript" } }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.VAPI_WEBHOOK_SECRET = "s3cret";
});

describe("POST /api/lab/webhook — x-vapi-secret gate (VOZ-186)", () => {
  it("403s when the x-vapi-secret header is missing", async () => {
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("403s on a wrong secret", async () => {
    const res = await POST(req({ "x-vapi-secret": "wrong" }));
    expect(res.status).toBe(403);
    expect(handleWebhook).not.toHaveBeenCalled();
  });

  it("delegates to the engine on the correct secret", async () => {
    const res = await POST(req({ "x-vapi-secret": "s3cret" }));
    expect(res.status).toBe(200);
    expect(handleWebhook).toHaveBeenCalledWith({ type: "transcript" });
  });

  it("still 400s invalid JSON (auth passes first)", async () => {
    const bad = new Request("http://localhost/api/lab/webhook", {
      method: "POST",
      headers: { "x-vapi-secret": "s3cret" },
      body: "{nope",
    });
    const res = await POST(bad);
    expect(res.status).toBe(400);
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
