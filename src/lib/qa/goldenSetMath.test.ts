import { describe, it, expect } from "vitest";
import {
  humanSuccess,
  toCalibrationRows,
  computePromptVersionStats,
  dedupeLabelsByCall,
  type GoldenItemLite,
  type JudgeOutcome,
  type PromptScoreRow,
  type RawLabel,
} from "./goldenSetMath";

describe("humanSuccess", () => {
  it("maps good->success, bad->failure", () => {
    expect(humanSuccess("good")).toBe("success");
    expect(humanSuccess("bad")).toBe("failure");
  });
});

describe("toCalibrationRows", () => {
  const item = (id: string, callId: string | null, humanVerdict: "good" | "bad"): GoldenItemLite => ({
    id,
    callId,
    humanVerdict,
  });

  it("maps human verdict and carries the judge outcome", () => {
    const items = [item("i1", "c1", "good"), item("i2", "c2", "bad")];
    const judge = new Map<string, JudgeOutcome>([
      ["i1", "success"],
      ["i2", "failure"],
    ]);
    expect(toCalibrationRows(items, judge)).toEqual([
      { call_id: "c1", success_verdict: "success", human_success: "success" },
      { call_id: "c2", success_verdict: "failure", human_success: "failure" },
    ]);
  });

  it("uses item id as call_id when callId is null (synthetic), and passes a missing judge outcome through as null", () => {
    const items = [item("syn1", null, "good")];
    const judge = new Map<string, JudgeOutcome>(); // i.e. judge skipped/errored => null
    expect(toCalibrationRows(items, judge)).toEqual([
      { call_id: "syn1", success_verdict: null, human_success: "success" },
    ]);
  });
});

describe("computePromptVersionStats", () => {
  const row = (pv: string | null, match: string, verdict: string | null): PromptScoreRow => ({
    prompt_version_id: pv,
    prompt_version_match: match,
    success_verdict: verdict,
  });

  it("returns [] on empty input", () => {
    expect(computePromptVersionStats([])).toEqual([]);
  });

  it("groups by prompt_version_id; success_rate is over DECIDED (good/bad) only", () => {
    const stats = computePromptVersionStats([
      row("v6", "single", "success"),
      row("v6", "single", "failure"),
      row("v6", "time_window", "unsure"), // counted as unsure, excluded from the rate denominator
      row("v7", "single", "success"),
      row("v7", "single", "success"),
    ]);
    const v6 = stats.find((s) => s.promptVersionId === "v6");
    const v7 = stats.find((s) => s.promptVersionId === "v7");
    expect(v6).toEqual({ promptVersionId: "v6", n: 2, success: 1, failure: 1, unsure: 1, successRate: 0.5 });
    expect(v7).toEqual({ promptVersionId: "v7", n: 2, success: 2, failure: 0, unsure: 0, successRate: 1 });
  });

  it("excludes ambiguous/unresolved matches and null prompt_version_id (rigorous attribution only)", () => {
    const stats = computePromptVersionStats([
      row("v6", "ambiguous", "success"),
      row("v6", "unresolved", "success"),
      row(null, "single", "success"),
    ]);
    expect(stats).toEqual([]);
  });

  it("successRate is null when a version has only unsure (no decided calls)", () => {
    const stats = computePromptVersionStats([row("v8", "single", "unsure")]);
    expect(stats).toEqual([
      { promptVersionId: "v8", n: 0, success: 0, failure: 0, unsure: 1, successRate: null },
    ]);
  });
});

describe("dedupeLabelsByCall", () => {
  const lbl = (callId: string, verdict: "good" | "bad", labeledBy: string, reason: string | null = null): RawLabel => ({
    callId,
    verdict,
    reason,
    labeledBy,
  });

  it("passes a single-reviewer label through unchanged", () => {
    expect(dedupeLabelsByCall([lbl("c1", "good", "operator", "agreed to SMS")])).toEqual([
      { callId: "c1", verdict: "good", reason: "agreed to SMS", labeledBy: "operator", labelerCount: 1 },
    ]);
  });

  it("collapses agreeing reviewers to one verdict with majority provenance", () => {
    expect(dedupeLabelsByCall([lbl("c1", "good", "alice"), lbl("c1", "good", "bob")])).toEqual([
      { callId: "c1", verdict: "good", reason: null, labeledBy: "majority 2/2", labelerCount: 2 },
    ]);
  });

  it("takes the majority verdict when reviewers disagree", () => {
    expect(
      dedupeLabelsByCall([lbl("c1", "good", "alice"), lbl("c1", "good", "bob"), lbl("c1", "bad", "carol")]),
    ).toEqual([{ callId: "c1", verdict: "good", reason: null, labeledBy: "majority 2/3", labelerCount: 3 }]);
  });

  it("drops a call on a reviewer tie (no trusted verdict)", () => {
    expect(dedupeLabelsByCall([lbl("c1", "good", "alice"), lbl("c1", "bad", "bob")])).toEqual([]);
  });

  it("handles multiple calls independently and preserves first-seen order", () => {
    const out = dedupeLabelsByCall([lbl("c1", "good", "operator"), lbl("c2", "bad", "operator")]);
    expect(out.map((d) => [d.callId, d.verdict])).toEqual([
      ["c1", "good"],
      ["c2", "bad"],
    ]);
  });

  it("takes the representative reason from the winning side", () => {
    const out = dedupeLabelsByCall([
      lbl("c1", "good", "alice", "clear yes"),
      lbl("c1", "bad", "bob", "ambiguous"),
      lbl("c1", "good", "carol", "confirmed"),
    ]);
    expect(out[0].verdict).toBe("good");
    expect(out[0].reason).toBe("clear yes");
    expect(out[0].labeledBy).toBe("majority 2/3");
  });
});
