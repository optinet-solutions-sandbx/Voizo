import { describe, expect, it } from "vitest";
import {
  decideAdmission,
  diffNewMembers,
  duePromotions,
  expectedCountryForTimezone,
  partitionRollover,
} from "./realtimePoll";

describe("expectedCountryForTimezone", () => {
  it("maps the three launch regions", () => {
    expect(expectedCountryForTimezone("Australia/Sydney")).toBe("AU");
    expect(expectedCountryForTimezone("Pacific/Auckland")).toBe("NZ");
    // +1 bucket: US/CA share a prefix — indistinguishable, known limit.
    expect(expectedCountryForTimezone("America/Toronto")).toBe("NA");
  });

  it("returns null for unmapped timezones (no constraint)", () => {
    expect(expectedCountryForTimezone("UTC")).toBeNull();
    expect(expectedCountryForTimezone("")).toBeNull();
    expect(expectedCountryForTimezone("Mars/Olympus_Mons")).toBeNull();
  });
});

describe("decideAdmission", () => {
  const base = { expectedCountry: "AU", addedToday: 0, dailyCap: 100 };

  it("admits a matching-country phone, normalized", () => {
    expect(decideAdmission({ ...base, rawPhone: "+61 412 345 678" })).toEqual({
      admit: true,
      phone: "+61412345678",
    });
  });

  it("rejects a wrong-country phone as rejected_country", () => {
    expect(decideAdmission({ ...base, rawPhone: "+14165550123" })).toEqual({
      admit: false,
      claimStatus: "rejected_country",
      phone: "+14165550123",
    });
  });

  it("admits any country when expectedCountry is null", () => {
    expect(
      decideAdmission({ ...base, expectedCountry: null, rawPhone: "+14165550123" }),
    ).toEqual({ admit: true, phone: "+14165550123" });
  });

  it("claims no_phone for a missing/blank phone", () => {
    expect(decideAdmission({ ...base, rawPhone: null })).toEqual({
      admit: false,
      claimStatus: "no_phone",
      phone: null,
    });
    expect(decideAdmission({ ...base, rawPhone: "   " })).toEqual({
      admit: false,
      claimStatus: "no_phone",
      phone: null,
    });
  });

  it("claims invalid_phone for an unnormalizable phone", () => {
    expect(decideAdmission({ ...base, rawPhone: "not-a-phone" })).toEqual({
      admit: false,
      claimStatus: "invalid_phone",
      phone: null,
    });
  });

  it("cap-blocks WITHOUT claiming (retryable on a later day)", () => {
    expect(
      decideAdmission({ ...base, addedToday: 100, rawPhone: "+61412345678" }),
    ).toEqual({ admit: false, capBlocked: true });
  });

  it("null cap = uncapped", () => {
    expect(
      decideAdmission({ ...base, dailyCap: null, addedToday: 9999, rawPhone: "+61412345678" })
        .admit,
    ).toBe(true);
  });

  it("cap check runs BEFORE phone/country work (a capped day claims nothing)", () => {
    expect(decideAdmission({ ...base, addedToday: 100, rawPhone: null })).toEqual({
      admit: false,
      capBlocked: true,
    });
  });
});

describe("diffNewMembers", () => {
  it("returns only unseen ids, preserving order, deduped", () => {
    expect(diffNewMembers(["a", "b", "a", "c"], new Set(["b"]))).toEqual(["a", "c"]);
  });

  it("empty inputs", () => {
    expect(diffNewMembers([], new Set())).toEqual([]);
    expect(diffNewMembers([], new Set(["x"]))).toEqual([]);
  });

  it("all seen → empty", () => {
    expect(diffNewMembers(["a", "b"], new Set(["a", "b"]))).toEqual([]);
  });
});

describe("partitionRollover", () => {
  it("carries pending + pending_retry with attempt_count preserved; closes exactly those rows", () => {
    const rows = [
      { id: "1", phone_e164: "+61400000001", attempt_count: 0, outcome: "pending" },
      { id: "2", phone_e164: "+61400000002", attempt_count: 2, outcome: "pending_retry" },
      { id: "3", phone_e164: "+61400000003", attempt_count: 1, outcome: "sent_sms" },
      { id: "4", phone_e164: "+61400000004", attempt_count: null, outcome: "pending" },
      { id: "5", phone_e164: "+61400000005", attempt_count: 3, outcome: "unreached" },
    ];
    const { carry, closeIds } = partitionRollover(rows);
    expect(carry).toEqual([
      { phone_e164: "+61400000001", attempt_count: 0 },
      { phone_e164: "+61400000002", attempt_count: 2 },
      { phone_e164: "+61400000004", attempt_count: 0 },
    ]);
    expect(closeIds).toEqual(["1", "2", "4"]);
  });

  it("nothing open → nothing carried", () => {
    expect(
      partitionRollover([{ id: "1", phone_e164: "+61400000001", attempt_count: 1, outcome: "sent_sms" }]),
    ).toEqual({ carry: [], closeIds: [] });
    expect(partitionRollover([])).toEqual({ carry: [], closeIds: [] });
  });
});

describe("duePromotions", () => {
  const NOW = new Date("2026-07-13T10:00:00Z");
  const row = (id: string, minsAgo: number) => ({
    cio_id: id,
    phone_e164: "+61400000000",
    first_seen_at: new Date(NOW.getTime() - minsAgo * 60_000).toISOString(),
  });

  it("due only when first_seen + delay has passed", () => {
    const rows = [row("a", 31), row("b", 29)];
    expect(duePromotions(rows, 30, NOW, 10).map((r) => r.cio_id)).toEqual(["a"]);
  });

  it("null delay = everything waiting is due (delay cleared mid-flight)", () => {
    expect(duePromotions([row("a", 0), row("b", 500)], null, NOW, 10)).toHaveLength(2);
  });

  it("oldest first, sliced to cap room", () => {
    const rows = [row("young", 40), row("old", 90), row("mid", 60)];
    expect(duePromotions(rows, 30, NOW, 2).map((r) => r.cio_id)).toEqual(["old", "mid"]);
  });

  it("no room = nothing promotes", () => {
    expect(duePromotions([row("a", 90)], 30, NOW, 0)).toEqual([]);
  });

  it("cutoff is inclusive: a member seen EXACTLY delay-minutes ago is due", () => {
    // first_seen + delay == now → getTime() <= cutoff, so it promotes. Pins the
    // <= boundary against an off-by-one that would hold a fully-served signup.
    expect(duePromotions([row("edge", 30)], 30, NOW, 10).map((r) => r.cio_id)).toEqual(["edge"]);
  });

  it("delay of 0 promotes immediately (cutoff = now, distinct input from null)", () => {
    // call_delay_minutes can be 0 (routes through the promotion pass, unlike
    // null which queues directly); a 0-minute delay is served on the next tick.
    expect(duePromotions([row("a", 0), row("b", 1)], 0, NOW, 10)).toHaveLength(2);
  });

  it("negative room promotes nothing (room = cap - addedToday after a soft overshoot)", () => {
    // A soft-cap breach (see decideAdmission suite) leaves addedToday > cap, so
    // room goes negative; the guard must reject it, not slice(0, -n) the queue.
    expect(duePromotions([row("a", 90), row("b", 91)], 30, NOW, -5)).toEqual([]);
  });
});

describe("decideAdmission — daily cap boundary + overlap semantics", () => {
  const valid = (addedToday: number, dailyCap: number | null) =>
    decideAdmission({ rawPhone: "+61412345678", expectedCountry: "AU", addedToday, dailyCap });

  it("admits at cap-1, blocks exactly at cap (>= boundary)", () => {
    expect(valid(99, 100).admit).toBe(true);
    expect(valid(100, 100)).toEqual({ admit: false, capBlocked: true });
  });

  it("dailyCap of 0 blocks the very first member", () => {
    expect(valid(0, 0)).toEqual({ admit: false, capBlocked: true });
  });

  it("blocks when already over cap (addedToday > cap)", () => {
    expect(valid(150, 100)).toEqual({ admit: false, capBlocked: true });
  });

  // The two invariants the supervised real-money trial hinges on. Mirrors
  // pollRealtimeParent step 6: one addedToday SNAPSHOT per tick, then a loop
  // that feeds each decision the running total (addedToday + admitted).
  const runTick = (startCount: number, cap: number, candidates: number): number => {
    let admitted = 0;
    for (let i = 0; i < candidates; i++) {
      const d = decideAdmission({
        rawPhone: "+61412345678",
        expectedCountry: "AU",
        addedToday: startCount + admitted, // running total, exactly as the loop does
        dailyCap: cap,
      });
      if ("capBlocked" in d) break;
      if (d.admit) admitted++;
    }
    return admitted;
  };

  it("cap is HARD within a single tick (running total is respected, never overshoots)", () => {
    expect(runTick(90, 100, 50)).toBe(10); // 90 in, 10 room, 50 eager → exactly 10
    expect(runTick(0, 100, 250)).toBe(100); // stops dead at the cap
  });

  it("cap is SOFT across overlapping ticks (known limit — stateless, snapshot per tick)", () => {
    // Two ticks fire before either commits, so BOTH read the same stale count.
    const snapshot = 90;
    const cap = 100;
    const tickA = runTick(snapshot, cap, 50);
    const tickB = runTick(snapshot, cap, 50); // same snapshot → overlap
    expect(tickA).toBe(10);
    expect(tickB).toBe(10);
    // Combined the child lands at 110 — 10 over cap. This pins the documented
    // "cap is soft under overlapping ticks" behavior: decideAdmission keeps no
    // cross-call memory, so a future change that assumes a hard cap trips here.
    expect(snapshot + tickA + tickB).toBe(110);
    expect(snapshot + tickA + tickB).toBeGreaterThan(cap);
  });
});
