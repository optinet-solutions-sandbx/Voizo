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
});
