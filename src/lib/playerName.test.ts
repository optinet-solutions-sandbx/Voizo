import { describe, it, expect } from "vitest";
import { cleanFirstName, customerE164Candidates } from "./playerName";

// Speech-boundary hygiene for imported player names. Stored display_name stays RAW
// as Customer.io gave it; cleanFirstName runs only where a name would be SPOKEN
// (script-engine variables) or greeting-formatted. Real shapes from the 2026-07-17
// segment preview: "kassandra sergerie lefrancois", "Vicky Seavers", null.
describe("cleanFirstName", () => {
  it("takes the first token and Title-Cases it", () => {
    expect(cleanFirstName("kassandra sergerie lefrancois")).toBe("Kassandra");
    expect(cleanFirstName("Vicky Seavers")).toBe("Vicky");
    expect(cleanFirstName("MARIA")).toBe("Maria");
  });

  it("keeps hyphens and apostrophes with per-part capitalization", () => {
    expect(cleanFirstName("jean-luc picard")).toBe("Jean-Luc");
    expect(cleanFirstName("o'brien terry")).toBe("O'Brien");
  });

  it("accepts accented letters (CA segments carry French names)", () => {
    expect(cleanFirstName("josé garcia")).toBe("José");
    expect(cleanFirstName("rené lefrancois")).toBe("René");
  });

  it("rejects email-ish, digit-bearing and symbol-bearing strings", () => {
    expect(cleanFirstName("kassandra303423@gmail.com")).toBeNull();
    expect(cleanFirstName("player123")).toBeNull();
    expect(cleanFirstName("™️vip")).toBeNull();
    expect(cleanFirstName("+61402294427")).toBeNull();
  });

  it("rejects too-short and too-long tokens", () => {
    expect(cleanFirstName("j")).toBeNull();
    expect(cleanFirstName("a".repeat(21) + " smith")).toBeNull();
  });

  it("null-safes non-strings and blanks", () => {
    expect(cleanFirstName(null)).toBeNull();
    expect(cleanFirstName(undefined)).toBeNull();
    expect(cleanFirstName("")).toBeNull();
    expect(cleanFirstName("   ")).toBeNull();
  });
});

// VOZ-539 (2026-09-17). Shapes copied from Vapi GET /call on real calls the night
// before: AU 01a0ace1 and NZ 01a0ac74 carry SquareTalk's routing prefix in the SIP
// user part and NO customer.number; CA 01a0aabd arrives as clean E.164 with both.
// The old seed read customer.number only, so AU/NZ never matched a contact row.
describe("customerE164Candidates", () => {
  it("recovers the AU number behind SquareTalk's routing prefix", () => {
    const c = customerE164Candidates({ sipUri: "sip:220161474271005@44.229.228.186:5060", name: "Outbound Call" });
    expect(c).toContain("+61474271005");
  });

  it("recovers the NZ number behind a longer prefix", () => {
    expect(customerE164Candidates({ sipUri: "sip:99900164210595128@44.238.177.138:5060" })).toContain("+64210595128");
  });

  it("keeps the CA path: customer.number is a candidate and its sipUri twin collapses", () => {
    const c = customerE164Candidates({ number: "+14312640769", sipUri: "sip:+14312640769@44.229.228.186:5060" });
    expect(c).toContain("+14312640769");
    expect(new Set(c).size).toBe(c.length);
  });

  it("normalizes a bare customer.number when there is no sipUri", () => {
    expect(customerE164Candidates({ number: "61402294427" })).toEqual(["+61402294427"]);
  });

  it("emits only valid E.164 strings", () => {
    for (const c of customerE164Candidates({ sipUri: "sip:220161474271005@h" })) expect(c).toMatch(/^\+\d{8,15}$/);
  });

  it("returns nothing to match on when the payload carries no usable digits", () => {
    expect(customerE164Candidates(undefined)).toEqual([]);
    expect(customerE164Candidates(null)).toEqual([]);
    expect(customerE164Candidates({})).toEqual([]);
    expect(customerE164Candidates({ sipUri: "sip:anonymous@h" })).toEqual([]);
    expect(customerE164Candidates({ sipUri: "sip:1234567@h" })).toEqual([]); // 7 digits: below the E.164 floor
  });
});
