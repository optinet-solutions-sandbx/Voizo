import { describe, expect, it } from "vitest";
import {
  AI_BURST_MIN_VAPI_CALLS,
  AI_BURST_SHARE_THRESHOLD,
  CONNECT_COLLAPSE_MIN_DIALS,
  CONNECT_COLLAPSE_RATE_THRESHOLD,
  detectAiPipelineBurst,
  detectConnectCollapse,
} from "./anomalyDetectors";

describe("detectAiPipelineBurst — VOZ-279 detector A (quota death / provider outage)", () => {
  it("trips on the 08-02 shape: most Vapi-reaching calls are pipeline errors", () => {
    // 08-02 measured: 75.6% pipeline-error among all calls in the window.
    const reasons = [
      ...Array(15).fill("pipeline-error-openai-429-exceeded-quota"),
      ...Array(3).fill("customer-ended-call"),
      ...Array(10).fill(null), // rejects that never reached Vapi — must not dilute
    ];
    const r = detectAiPipelineBurst(reasons);
    expect(r.trip).toBe(true);
    expect(r.vapiCount).toBe(18);
    expect(r.errCount).toBe(15);
  });
  it("does not trip on a healthy mix (08-01 base rate is 0%)", () => {
    const reasons = [
      ...Array(50).fill("assistant-said-end-call-phrase"),
      ...Array(20).fill("customer-ended-call"),
      ...Array(30).fill(null),
    ];
    expect(detectAiPipelineBurst(reasons).trip).toBe(false);
  });
  it("nulls alone never trip it (blocked-CID storm reaches zero Vapi calls)", () => {
    expect(detectAiPipelineBurst(Array(500).fill(null)).trip).toBe(false);
  });
  it("respects the minimum Vapi-call sample", () => {
    const few = Array(AI_BURST_MIN_VAPI_CALLS - 1).fill("pipeline-error-openai-429-exceeded-quota");
    expect(detectAiPipelineBurst(few).trip).toBe(false);
  });
  it("trips exactly at the share threshold, not below", () => {
    const n = 20;
    const errAt = Math.ceil(n * AI_BURST_SHARE_THRESHOLD);
    const at = [...Array(errAt).fill("pipeline-error-x"), ...Array(n - errAt).fill("customer-ended-call")];
    const below = [...Array(errAt - 1).fill("pipeline-error-x"), ...Array(n - errAt + 1).fill("customer-ended-call")];
    expect(detectAiPipelineBurst(at).trip).toBe(true);
    expect(detectAiPipelineBurst(below).trip).toBe(false);
  });
});

describe("detectConnectCollapse — VOZ-279 detector B (trunk/CID-level, platform-wide)", () => {
  const call = (cause: string, dur: number) => ({ hangup_cause: cause, duration_seconds: dur });
  it("trips on the 08-03 shape: reject storm, ~10% connect", () => {
    const rows = [
      ...Array(90).fill(call("CALL_REJECTED", 0)),
      ...Array(10).fill(call("NORMAL_CLEARING", 20)),
    ];
    const r = detectConnectCollapse(rows);
    expect(r.trip).toBe(true);
    expect(r.dials).toBe(100);
    expect(r.connected).toBe(10);
  });
  it("does not trip on the healthy baseline (~82% connect)", () => {
    const rows = [
      ...Array(82).fill(call("NORMAL_CLEARING", 20)),
      ...Array(18).fill(call("NO_ANSWER", 0)),
    ];
    expect(detectConnectCollapse(rows).trip).toBe(false);
  });
  it("respects the minimum dial sample (quiet nights must not alert)", () => {
    const rows = Array(CONNECT_COLLAPSE_MIN_DIALS - 1).fill(call("CALL_REJECTED", 0));
    expect(detectConnectCollapse(rows).trip).toBe(false);
  });
  it("NORMAL_CLEARING with zero duration does not count as connected", () => {
    const rows = [
      ...Array(30).fill(call("NORMAL_CLEARING", 0)),
    ];
    const r = detectConnectCollapse(rows);
    expect(r.connected).toBe(0);
    expect(r.trip).toBe(true);
  });
  it(`threshold sanity: rate ${CONNECT_COLLAPSE_RATE_THRESHOLD} is far below the 0.82 healthy baseline`, () => {
    expect(CONNECT_COLLAPSE_RATE_THRESHOLD).toBeLessThan(0.5);
  });
});
