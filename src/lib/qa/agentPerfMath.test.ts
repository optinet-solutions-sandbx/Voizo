import { describe, it, expect } from "vitest";
import {
  bucketFailureTheme,
  topFailureThemes,
  computeVerdictMix,
  rollupByBaseAgent,
  THEME_LABEL,
  MAX_CALLS_PER_THEME,
  type CampaignMeta,
  type FailureCallInput,
} from "./agentPerfMath";

// Boilerplate tail the judge appends to ~every failure rationale (the failure
// DEFINITION, not a theme). Tests reuse it to prove the strip works.
const TAIL = "and never agreed to receive details, log in, activate a bonus, deposit, or return to play.";

describe("bucketFailureTheme", () => {
  it("classifies an agent-consent failure (the actionable theme)", () => {
    expect(
      bucketFailureTheme(`The agent announced an SMS but the transcript ends before the customer gives any agreement.`),
    ).toBe("agent_no_consent");
    expect(
      bucketFailureTheme(`The customer acknowledged the free spins, but the agent unilaterally said they would send an SMS ${TAIL}`),
    ).toBe("agent_no_consent");
  });
  it("classifies a minimal / non-engaged reply", () => {
    expect(bucketFailureTheme(`The only customer response was "Thank you," ${TAIL}`)).toBe("minimal_reply");
    expect(bucketFailureTheme(`A real customer only said "Hello?" ${TAIL}`)).toBe("minimal_reply");
  });
  it("classifies a not-recognized / wrong-person failure", () => {
    expect(bucketFailureTheme(`The customer said the account was not theirs and asked for deletion, ${TAIL}`)).toBe("not_recognized");
    expect(bucketFailureTheme(`The customer said the registration did not sound familiar ${TAIL}`)).toBe("not_recognized");
  });
  it("classifies an explicit decline", () => {
    expect(bucketFailureTheme(`The customer declined the offer by saying "No, thanks" ${TAIL}`)).toBe("declined");
  });
  it("classifies a no-time / call-later failure (realistic phrasing, no standalone 'no')", () => {
    // Real rationales say "did not have time" (no standalone "no") so they don't trip declined's \bno\b.
    expect(bucketFailureTheme(`A real customer said they were busy at work and would try again later, ${TAIL}`)).toBe("no_time");
  });
  it("classifies a can't-afford failure", () => {
    expect(bucketFailureTheme(`The customer said they were broke and ended the call, ${TAIL}`)).toBe("cant_afford");
  });
  it("does NOT classify the pure boilerplate tail as a decisive theme", () => {
    // A rationale with NO decisive leading clause (just the boilerplate failure-tail)
    // must never fake a decisive bucket; it honestly lands in "other (needs review)".
    // This can't happen on real data (every failure has a leading clause) — it guards
    // the tail-strip so boilerplate text can't drive a theme match.
    const t = bucketFailureTheme(`The customer ${TAIL}`);
    expect(["agent_no_consent", "not_recognized", "declined", "no_time", "cant_afford"]).not.toContain(t);
    expect(t).toBe("other");
  });
});

describe("topFailureThemes", () => {
  // Builder for the drill-down input rows (callId-distinct unless overridden).
  const fc = (rationale: string, over: Partial<FailureCallInput> = {}): FailureCallInput => ({
    callId: "call-default",
    campaignId: "camp-1",
    campaignName: "L7_AU_Camp",
    calledAt: "2026-06-01T10:00:00+00:00",
    rationale,
    ...over,
  });

  it("counts, sorts themes desc, percentages over total, and carries call refs", () => {
    const calls = [
      fc(`The customer said the account was not theirs ${TAIL}`, { callId: "a1" }), // not_recognized
      fc(`The customer said the registration did not sound familiar ${TAIL}`, { callId: "a2" }), // not_recognized
      fc(`The only customer response was "Thanks" ${TAIL}`, { callId: "b1", campaignId: null, campaignName: null }), // minimal_reply
    ];
    const out = topFailureThemes(calls);
    expect(out[0].theme).toBe("not_recognized");
    expect(out[0].count).toBe(2);
    expect(out[0].pct).toBe(0.6667);
    expect(out[0].label).toBe(THEME_LABEL.not_recognized);
    expect(out[0].calls.map((c) => c.callId).sort()).toEqual(["a1", "a2"]);
    expect(out[0].callsTruncated).toBe(false);
    // refs flow through untouched, incl. a null campaign (renders unlinked, never dropped)
    const minimal = out.find((t) => t.theme === "minimal_reply")!;
    expect(minimal.calls[0]).toMatchObject({ callId: "b1", campaignId: null, campaignName: null });
    expect(out.reduce((s, t) => s + t.count, 0)).toBe(3);
  });

  it("keeps duplicate rationale texts as separate calls (refs are per-call, keyed by callId)", () => {
    const r = `The only customer response was "Thanks" ${TAIL}`;
    const out = topFailureThemes([fc(r, { callId: "d1" }), fc(r, { callId: "d2" })]);
    expect(out[0].calls.map((c) => c.callId).sort()).toEqual(["d1", "d2"]);
    expect(out[0].count).toBe(2);
  });

  it("orders calls newest-first, unknown dates last, callId as the tiebreak", () => {
    const r = `The customer declined the offer by saying "No, thanks" ${TAIL}`;
    const calls = [
      fc(r, { callId: "older", calledAt: "2026-05-01T00:00:00+00:00" }),
      fc(r, { callId: "newest", calledAt: "2026-06-09T00:00:00+00:00" }),
      fc(r, { callId: "undated", calledAt: null }),
      fc(r, { callId: "tie-b", calledAt: "2026-05-01T00:00:00+00:00" }),
    ];
    expect(topFailureThemes(calls)[0].calls.map((c) => c.callId)).toEqual(["newest", "older", "tie-b", "undated"]);
  });

  it("caps refs at MAX_CALLS_PER_THEME with the newest slice; count stays exact; truncation flagged", () => {
    const r = `The only customer response was "Hello?" ${TAIL}`;
    const calls = Array.from({ length: MAX_CALLS_PER_THEME + 10 }, (_, i) =>
      fc(r, {
        callId: `c-${String(i).padStart(3, "0")}`,
        calledAt: `2026-0${(i % 5) + 1}-${String((i % 28) + 1).padStart(2, "0")}T00:00:00+00:00`,
      }),
    );
    const out = topFailureThemes(calls);
    expect(out[0].count).toBe(MAX_CALLS_PER_THEME + 10);
    expect(out[0].calls.length).toBe(MAX_CALLS_PER_THEME);
    expect(out[0].callsTruncated).toBe(true);
    // the kept slice is newest-first throughout
    const kept = out[0].calls.map((c) => Date.parse(c.calledAt!));
    for (let i = 1; i < kept.length; i++) expect(kept[i - 1]).toBeGreaterThanOrEqual(kept[i]);
  });

  it("is total on empty input", () => {
    expect(topFailureThemes([])).toEqual([]);
  });
});

describe("computeVerdictMix", () => {
  it("counts verdicts; percentages are over DECIDED verdicts so they sum to 100%", () => {
    const m = computeVerdictMix(["success", "failure", "unsure", "unsure", null]);
    expect(m).toMatchObject({ success: 1, failure: 1, unsure: 2, unscored: 1, total: 5 });
    // scored = 4 (the null is excluded from the denominator) → unsure 2/4 = 0.5
    expect(m.unsurePct).toBe(0.5);
    expect((m.successPct ?? 0) + (m.failurePct ?? 0) + (m.unsurePct ?? 0)).toBeCloseTo(1);
  });
  it("nulls percentages on empty input", () => {
    expect(computeVerdictMix([])).toMatchObject({ total: 0, successPct: null });
  });
});

describe("rollupByBaseAgent", () => {
  const meta: Map<string, CampaignMeta> = new Map([
    ["c1", { baseAssistantId: "base-aaaaaaaa-1", name: "L7_AU_Camp", isTest: false }],
    ["c2", { baseAssistantId: "base-aaaaaaaa-1", name: "L7_AU_Camp2", isTest: false }],
    ["c3", { baseAssistantId: null, name: "Legacy", isTest: false }],
    ["t1", { baseAssistantId: "base-bbbbbbbb-2", name: "TEST", isTest: true }],
  ]);
  const rows = [
    { campaign_id: "c1", success_verdict: "success", axis_accuracy: 4, axis_clarity: 5, axis_natural_flow: 3 },
    { campaign_id: "c2", success_verdict: "failure", axis_accuracy: 2, axis_clarity: null, axis_natural_flow: 4 },
    { campaign_id: "c3", success_verdict: "unsure", axis_accuracy: null, axis_clarity: null, axis_natural_flow: null },
    { campaign_id: "t1", success_verdict: "success", axis_accuracy: 5, axis_clarity: 5, axis_natural_flow: 5 },
    { campaign_id: null, success_verdict: "failure", axis_accuracy: 1, axis_clarity: 1, axis_natural_flow: 1 },
  ];
  it("groups by base agent, excludes test, averages axes skipping nulls", () => {
    const out = rollupByBaseAgent(rows, meta);
    const base1 = out.find((a) => a.baseAssistantId === "base-aaaaaaaa-1")!;
    expect(base1.scored).toBe(2);
    expect(base1.success).toBe(1);
    expect(base1.failure).toBe(1);
    expect(base1.campaignNames).toEqual(["L7_AU_Camp", "L7_AU_Camp2"]);
    expect(base1.avgClarity).toBe(5); // only one non-null clarity (5)
    expect(base1.shortId).toBe("base-aaa");
    // the test campaign (t1) is excluded entirely
    expect(out.find((a) => a.baseAssistantId === "base-bbbbbbbb-2")).toBeUndefined();
    // null base + null campaign both fall to "unattributed"
    const un = out.find((a) => a.baseAssistantId === "unattributed")!;
    expect(un.scored).toBe(2);
  });
  it("is total on empty input", () => {
    expect(rollupByBaseAgent([], meta)).toEqual([]);
  });
});
