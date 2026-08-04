import { describe, expect, it } from "vitest";
import { isRejectStreak, REJECT_BREAKER_STREAK } from "./rejectBreaker";

const rejects = (n: number) => Array<string>(n).fill("CALL_REJECTED");

describe("isRejectStreak — VOZ-278 circuit breaker predicate", () => {
  it("trips on exactly the streak length of consecutive rejects", () => {
    expect(isRejectStreak(rejects(REJECT_BREAKER_STREAK))).toBe(true);
  });
  it("does not trip one short of the streak", () => {
    expect(isRejectStreak(rejects(REJECT_BREAKER_STREAK - 1))).toBe(false);
  });
  it("a single recent non-reject breaks the streak (causes are newest-first)", () => {
    expect(isRejectStreak(["NORMAL_CLEARING", ...rejects(REJECT_BREAKER_STREAK)])).toBe(false);
  });
  it("older non-rejects beyond the streak window do not matter", () => {
    expect(isRejectStreak([...rejects(REJECT_BREAKER_STREAK), "NORMAL_CLEARING"])).toBe(true);
  });
  it("a null cause (in-flight or unknown) breaks the streak defensively", () => {
    const causes: Array<string | null> = [...rejects(5)];
    causes.splice(2, 0, null);
    causes.push(...rejects(REJECT_BREAKER_STREAK));
    expect(isRejectStreak(causes.slice(0, REJECT_BREAKER_STREAK))).toBe(false);
  });
  it("empty input never trips", () => {
    expect(isRejectStreak([])).toBe(false);
  });
});
