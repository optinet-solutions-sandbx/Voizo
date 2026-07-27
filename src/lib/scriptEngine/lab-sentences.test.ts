import { describe, it, expect } from "vitest";
import { splitSentences, salientTokens, corpusTokenSet, sentenceSaid, unsaidSentences, lineFullySaid } from "./lab-sentences";

const OFFER = "You have twenty free spins. Plus a three hundred percent bonus on your next deposit. I'll text you the details.";

describe("splitSentences", () => {
  it("splits on terminal punctuation", () => {
    expect(splitSentences(OFFER)).toEqual([
      "You have twenty free spins.",
      "Plus a three hundred percent bonus on your next deposit.",
      "I'll text you the details.",
    ]);
  });
  it("splits on em-dash clauses and newlines", () => {
    expect(splitSentences("Heads up — this is only good today.\nCall us back.")).toEqual([
      "Heads up", "this is only good today.", "Call us back.",
    ]);
  });
  it("returns [] for empty / whitespace", () => {
    expect(splitSentences("")).toEqual([]);
    expect(splitSentences("   ")).toEqual([]);
  });
});

describe("salientTokens", () => {
  it("captures digits and number-words as fact carriers", () => {
    const t = salientTokens("a 300% bonus and twenty spins");
    expect(t).toContain("300");
    expect(t).toContain("twenty");
    expect(t).toContain("bonus");
    expect(t).toContain("spins");
  });
  it("keeps number-words whole (not truncated)", () => {
    expect(salientTokens("three hundred percent")).toEqual(expect.arrayContaining(["three", "hundred", "percent"]));
  });
});

describe("sentenceSaid — reword-tolerant token match", () => {
  it("true when a reworded transcript carries the sentence's salient tokens", () => {
    const corpus = corpusTokenSet("so i've popped twenty free spins onto your account");
    expect(sentenceSaid("You have twenty free spins.", corpus)).toBe(true);
  });
  it("false when the distinctive tokens are absent", () => {
    const corpus = corpusTokenSet("so i've popped twenty free spins onto your account");
    expect(sentenceSaid("Plus a three hundred percent bonus on your next deposit.", corpus)).toBe(false);
  });
  it("contentless fragments (<2 salient tokens) never hold the call open", () => {
    expect(sentenceSaid("Anyway.", new Set())).toBe(true); // 1 salient token
    expect(sentenceSaid("So, um—", new Set())).toBe(true); // 0 salient tokens
  });
});

describe("unsaidSentences — where the agent stopped", () => {
  it("returns only the tail after an interruption mid-line", () => {
    // Agent got out sentence 1 only, then was cut off.
    const corpus = corpusTokenSet("right so you've got twenty free spins there");
    expect(unsaidSentences(OFFER, corpus)).toEqual([
      "Plus a three hundred percent bonus on your next deposit.",
      "I'll text you the details.",
    ]);
  });
  it("empty once every sentence's tokens have been spoken", () => {
    const corpus = corpusTokenSet(
      "you've got twenty free spins, plus a three hundred percent bonus on your next deposit, and i'll text you the details",
    );
    expect(unsaidSentences(OFFER, corpus)).toEqual([]);
    expect(lineFullySaid(OFFER, corpus)).toBe(true);
  });
  it("whole line unsaid when nothing was spoken", () => {
    expect(unsaidSentences(OFFER, new Set()).length).toBe(3);
  });
});
