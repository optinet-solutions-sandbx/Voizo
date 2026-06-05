import { describe, it, expect } from "vitest";
import { parseVerdict, judgeVersion, JUDGE_SYSTEM_PROMPT } from "./judgePrompt";

describe("parseVerdict", () => {
  it("parses a clean verdict JSON", () => {
    const raw = JSON.stringify({
      success_verdict: "success",
      success_confidence: 0.9,
      success_path: "sms",
      axis_accuracy: 4,
      axis_clarity: 5,
      axis_natural_flow: 4,
      rationale: "Customer said 'go ahead' to the SMS offer.",
    });
    const v = parseVerdict(raw);
    expect(v).not.toBeNull();
    expect(v!.success_verdict).toBe("success");
    expect(v!.success_path).toBe("sms");
    expect(v!.success_confidence).toBeCloseTo(0.9);
  });

  it("tolerates prose-wrapped / fenced JSON", () => {
    const raw =
      "Here is the verdict:\n```json\n{\"success_verdict\":\"failure\",\"success_confidence\":0.7,\"success_path\":\"none\",\"rationale\":\"declined\"}\n```";
    const v = parseVerdict(raw);
    expect(v!.success_verdict).toBe("failure");
    expect(v!.success_path).toBe("none");
  });

  it("rejects an out-of-enum verdict", () => {
    expect(parseVerdict(JSON.stringify({ success_verdict: "maybe", rationale: "x" }))).toBeNull();
  });

  it("returns null on non-JSON", () => {
    expect(parseVerdict("the model refused")).toBeNull();
  });

  it("coerces missing optional axes to null, keeps required verdict", () => {
    const v = parseVerdict(
      JSON.stringify({ success_verdict: "unsure", success_confidence: 0.4, rationale: "garbled" }),
    );
    expect(v!.success_verdict).toBe("unsure");
    expect(v!.axis_accuracy).toBeNull();
    expect(v!.success_path).toBe("none"); // defaulted
  });
});

describe("judgeVersion", () => {
  it("is stable for the same prompt+model", () => {
    expect(judgeVersion("claude-sonnet-4-6")).toBe(judgeVersion("claude-sonnet-4-6"));
  });
  it("changes when the model changes", () => {
    expect(judgeVersion("claude-sonnet-4-6")).not.toBe(judgeVersion("claude-haiku-4-5"));
  });
  it("changes when the prompt changes (guards against silent drift)", () => {
    expect(judgeVersion("m", "PROMPT_A")).not.toBe(judgeVersion("m", "PROMPT_B"));
  });
});

describe("JUDGE_SYSTEM_PROMPT", () => {
  it("anchors the Voizo success definition and JSON-only output", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/success/i);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/JSON/i);
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/voicemail|recording|machine/i);
  });
});
