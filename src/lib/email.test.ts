import { describe, it, expect, vi, afterEach } from "vitest";
import { sendEmail } from "./email";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("sendEmail", () => {
  it("throws loudly when RESEND_API_KEY is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("RESEND_FROM", "Voizo <snapshot@example.com>");
    await expect(sendEmail(["a@x.com"], "s", "<p>h</p>")).rejects.toThrow(/RESEND_API_KEY/);
  });

  it("throws loudly when RESEND_FROM is missing", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM", "");
    await expect(sendEmail(["a@x.com"], "s", "<p>h</p>")).rejects.toThrow(/RESEND_FROM/);
  });

  it("POSTs to Resend and returns the message id on success", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM", "Voizo <snapshot@example.com>");
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ id: "msg_123" }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const id = await sendEmail(["a@x.com", "b@x.com"], "Subj", "<p>body</p>");
    expect(id).toBe("msg_123");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.resend.com/emails");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer re_test");
    const body = JSON.parse(init.body as string);
    expect(body.from).toBe("Voizo <snapshot@example.com>");
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
    expect(body.subject).toBe("Subj");
    expect(body.html).toBe("<p>body</p>");
  });

  it("throws on a non-2xx Resend response", async () => {
    vi.stubEnv("RESEND_API_KEY", "re_test");
    vi.stubEnv("RESEND_FROM", "Voizo <snapshot@example.com>");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad domain", { status: 422 })));
    await expect(sendEmail(["a@x.com"], "s", "<p>h</p>")).rejects.toThrow(/Resend.*422/);
  });
});
