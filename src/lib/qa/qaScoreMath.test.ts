import { describe, it, expect } from "vitest";
import { attributePromptVersion, computeCalibration } from "./qaScoreMath";

// versions: prompt_versions rows for the campaign, ascending created_at.
const v = (id: string, iso: string) => ({ id, created_at: iso });

describe("attributePromptVersion", () => {
  it("unresolved when the campaign has no versions", () => {
    expect(attributePromptVersion("2026-06-01T00:00:00Z", [])).toEqual({
      promptVersionId: null,
      match: "unresolved",
    });
  });
  it("single when exactly one version existed at/before the call", () => {
    const r = attributePromptVersion("2026-06-02T00:00:00Z", [v("a", "2026-06-01T00:00:00Z")]);
    expect(r).toEqual({ promptVersionId: "a", match: "single" });
  });
  it("time_window picks the latest version at/before the call when several exist", () => {
    const r = attributePromptVersion("2026-06-03T12:00:00Z", [
      v("a", "2026-06-01T00:00:00Z"),
      v("b", "2026-06-03T00:00:00Z"),
      v("c", "2026-06-04T00:00:00Z"),
    ]);
    expect(r).toEqual({ promptVersionId: "b", match: "time_window" });
  });
  it("unresolved when the call predates every version", () => {
    const r = attributePromptVersion("2026-05-01T00:00:00Z", [v("a", "2026-06-01T00:00:00Z")]);
    expect(r).toEqual({ promptVersionId: null, match: "unresolved" });
  });
  it("ambiguous when two versions share the same created_at boundary", () => {
    const r = attributePromptVersion("2026-06-02T00:00:00Z", [
      v("a", "2026-06-01T00:00:00Z"),
      v("b", "2026-06-01T00:00:00Z"),
    ]);
    expect(r.match).toBe("ambiguous");
  });
  it("downgrades to ambiguous when a sibling version date is unparseable", () => {
    const r = attributePromptVersion("2026-06-03T00:00:00Z", [
      v("a", "2026-06-01T00:00:00Z"),
      v("b", "not-a-date"),
    ]);
    expect(r.match).toBe("ambiguous");
    expect(r.promptVersionId).toBe("a");
  });
  it("unresolved when the call's own created_at is unparseable", () => {
    const r = attributePromptVersion("garbage", [v("a", "2026-06-01T00:00:00Z")]);
    expect(r).toEqual({ promptVersionId: null, match: "unresolved" });
  });
});

describe("computeCalibration", () => {
  const row = (call_id: string, judge: string | null, human: string | null) => ({
    call_id,
    success_verdict: judge,
    human_success: human,
  });

  it("returns n=0 on empty input", () => {
    expect(computeCalibration([])).toEqual({
      n: 0,
      agreement: 0,
      cohens_kappa: 0,
      matrix: { tp: 0, tn: 0, fp: 0, fn: 0 },
    });
  });

  it("perfect agreement gives kappa=1", () => {
    const r = computeCalibration([row("1", "success", "success"), row("2", "failure", "failure")]);
    expect(r.matrix).toEqual({ tp: 1, tn: 1, fp: 0, fn: 0 });
    expect(r.agreement).toBe(1);
    expect(r.cohens_kappa).toBe(1);
  });

  it("collapses multiple human labels per call by majority (counts the call ONCE)", () => {
    // call 1 labeled good/good/bad -> majority success; judge success -> tp once
    const r = computeCalibration([
      row("1", "success", "success"),
      row("1", "success", "success"),
      row("1", "success", "failure"),
    ]);
    expect(r.matrix).toEqual({ tp: 1, tn: 0, fp: 0, fn: 0 });
    expect(r.n).toBe(1);
  });

  it("drops a call on a human tie", () => {
    const r = computeCalibration([row("1", "success", "success"), row("1", "success", "failure")]);
    expect(r.n).toBe(0);
  });

  it("excludes judge-unsure and undecided-human rows", () => {
    const r = computeCalibration([row("1", "unsure", "success"), row("2", "success", null)]);
    expect(r.n).toBe(0);
  });
});
