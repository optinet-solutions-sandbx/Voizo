import { describe, it, expect, vi } from "vitest";
import { scoreTranscript, type JudgeClient } from "./scoreCall";

// A fake Anthropic-shaped client: { messages: { create: () => ... } }
const fakeClient = (text: string): JudgeClient => ({
  messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) },
});
const throwingClient = (): JudgeClient => ({
  messages: { create: vi.fn().mockRejectedValue(new Error("429 overloaded")) },
});

const REAL = "AI: Can I send you the details via SMS?\nUser: Yes, go ahead.";
const VOICEMAIL = "This message bank is full. Please leave a message after the tone.";

describe("scoreTranscript (guards before any API call)", () => {
  it("skips voicemail without calling the model", async () => {
    const c = fakeClient("{}");
    const r = await scoreTranscript({ transcript: VOICEMAIL }, { client: c, model: "m" });
    expect(r).toEqual({ ok: false, skipped: "voicemail" });
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("skips a non-conversation (no user turn)", async () => {
    const c = fakeClient("{}");
    const r = await scoreTranscript({ transcript: "AI: Hello? Hello?" }, { client: c, model: "m" });
    expect(r).toEqual({ ok: false, skipped: "no-conversation" });
    expect(c.messages.create).not.toHaveBeenCalled();
  });

  it("skips calls shorter than the minimum when duration is known", async () => {
    const c = fakeClient("{}");
    const r = await scoreTranscript(
      { transcript: REAL, durationSeconds: 5 },
      { client: c, model: "m", minDurationSeconds: 30 },
    );
    expect(r).toEqual({ ok: false, skipped: "too-short" });
  });

  it("scores a real conversation and returns a parsed verdict", async () => {
    const c = fakeClient(
      JSON.stringify({
        success_verdict: "success",
        success_confidence: 0.9,
        success_path: "sms",
        rationale: "said go ahead",
      }),
    );
    const r = await scoreTranscript({ transcript: REAL, durationSeconds: 60 }, { client: c, model: "m" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.verdict.success_verdict).toBe("success");
      expect(r.judgeVersion).toHaveLength(16);
    }
  });

  it("never throws on an API error — returns api-error skip", async () => {
    const c = throwingClient();
    const r = await scoreTranscript({ transcript: REAL, durationSeconds: 60 }, { client: c, model: "m" });
    expect(r).toEqual({ ok: false, skipped: "api-error" });
  });

  it("returns unparsable when the model emits non-JSON", async () => {
    const c = fakeClient("I cannot comply.");
    const r = await scoreTranscript({ transcript: REAL, durationSeconds: 60 }, { client: c, model: "m" });
    expect(r).toEqual({ ok: false, skipped: "unparsable" });
  });
});
