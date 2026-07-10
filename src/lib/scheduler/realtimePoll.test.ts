import { describe, expect, it } from "vitest";
import { decideAdmission, diffNewMembers, expectedCountryForTimezone } from "./realtimePoll";

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
