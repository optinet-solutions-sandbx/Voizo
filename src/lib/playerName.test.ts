import { describe, it, expect } from "vitest";
import { cleanFirstName } from "./playerName";

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
