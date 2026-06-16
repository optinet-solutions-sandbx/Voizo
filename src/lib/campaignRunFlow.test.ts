import { describe, it, expect } from "vitest";
import { deriveRunFlow, type RunFlowNumber } from "./campaignRunFlow";

const NOW = Date.parse("2026-06-15T12:00:00Z");
const iso = (offsetMin: number) => new Date(NOW + offsetMin * 60_000).toISOString();

// Helper: build a number with a created_at that preserves insertion order.
let seq = 0;
function num(o: Partial<RunFlowNumber>): RunFlowNumber {
  seq += 1;
  return { created_at: iso(-1000 + seq), phone_e164: `+10000000${seq}`, outcome: "pending", attempt_count: 0, ...o };
}

describe("deriveRunFlow", () => {
  it("running campaign: now-dialing, up-next, counts, next retry window", () => {
    seq = 0;
    const numbers: RunFlowNumber[] = [
      num({ outcome: "not_interested" }),                                   // #1 done
      num({ outcome: "in_progress" }),                                      // #2 now dialing
      num({ outcome: "pending_retry", next_attempt_at: iso(30) }),          // #3 future retry
      num({ outcome: "pending" }),                                          // #4 up next
      num({ outcome: "pending" }),                                          // #5
      num({ outcome: "pending_retry", next_attempt_at: iso(90) }),          // #6 later retry
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.total).toBe(6);
    expect(f.done).toBe(1); // only the not_interested
    expect(f.pending).toBe(2);
    expect(f.awaitingRetry).toBe(2);
    expect(f.inProgress).toBe(1);
    expect(f.nowDialing).toEqual({ phone: "+100000002", position: 2 });
    expect(f.upNext).toEqual({ phone: "+100000004", position: 4 }); // first eligible (pending)
    expect(f.nextRetryAt).toBe(iso(30)); // earliest future window
  });

  it("an eligible pending_retry (window passed) outranks a later pending for up-next", () => {
    seq = 0;
    const numbers: RunFlowNumber[] = [
      num({ outcome: "pending_retry", next_attempt_at: iso(-5) }), // #1 window already passed → eligible now
      num({ outcome: "pending" }),                                 // #2
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.upNext).toEqual({ phone: "+100000001", position: 1 });
    expect(f.nextRetryAt).toBeNull(); // the only retry is already due, not "future"
  });

  it("skips numbers at/over max_attempts when choosing up-next", () => {
    seq = 0;
    const numbers: RunFlowNumber[] = [
      num({ outcome: "pending", attempt_count: 3 }), // #1 exhausted — skip
      num({ outcome: "pending", attempt_count: 0 }), // #2 up next
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.upNext).toEqual({ phone: "+100000002", position: 2 });
  });

  it("paused/between calls: no in-progress → nowDialing null, up-next still resolves", () => {
    seq = 0;
    const numbers: RunFlowNumber[] = [
      num({ outcome: "not_interested" }),
      num({ outcome: "pending" }),
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.nowDialing).toBeNull();
    expect(f.upNext).toEqual({ phone: "+100000002", position: 2 });
  });

  it("all terminal: done = total, no up-next, no future retry", () => {
    seq = 0;
    const numbers: RunFlowNumber[] = [
      num({ outcome: "not_interested" }),
      num({ outcome: "unreached" }),
      num({ outcome: "sent_sms" }),
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.done).toBe(3);
    expect(f.pending).toBe(0);
    expect(f.upNext).toBeNull();
    expect(f.nowDialing).toBeNull();
    expect(f.nextRetryAt).toBeNull();
  });

  it("sorts by created_at so positions reflect dial order regardless of input order", () => {
    const numbers: RunFlowNumber[] = [
      { created_at: iso(3), phone_e164: "+1C", outcome: "pending" },
      { created_at: iso(1), phone_e164: "+1A", outcome: "in_progress" },
      { created_at: iso(2), phone_e164: "+1B", outcome: "pending" },
    ];
    const f = deriveRunFlow(numbers, { maxAttempts: 3, nowMs: NOW });
    expect(f.nowDialing).toEqual({ phone: "+1A", position: 1 }); // earliest created_at
    expect(f.upNext).toEqual({ phone: "+1B", position: 2 });
  });
});
