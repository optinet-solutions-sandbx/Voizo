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

describe("salientTokens (VOZ-229)", () => {
  it("keeps content-word stems and drops numbers (digit AND word)", () => {
    const t = salientTokens("a 300% bonus and twenty free spins");
    expect(t).toContain("bonus");
    expect(t).toContain("spins");
    expect(t).not.toContain("300"); // digit — never matches spoken "three hundred"
    expect(t).not.toContain("twenty"); // number-word — dropped so digit-vs-word can't mismatch
  });
  it("strips authoring/instruction words a live agent never speaks", () => {
    const t = salientTokens("Mention the 20 Free Spins");
    expect(t).not.toContain("menti"); // "Mention"
    expect(t).toEqual(expect.arrayContaining(["free", "spins"]));
  });
  it("keeps short acronyms like SMS that the 4-char stemmer would drop", () => {
    expect(salientTokens("sending an SMS with the details")).toContain("sms");
  });
});

describe("VOZ-229 regression — instruction+number goals detected from reworded speech", () => {
  it("'Mention the 20 Free Spins' counts as said once the agent says 'twenty free spins'", () => {
    const corpus = corpusTokenSet("right so i've added twenty free spins to your account");
    expect(sentenceSaid("Mention the 20 Free Spins", corpus)).toBe(true);
  });
  it("'Mention the 300% Deposit Bonus' counts as said from 'three hundred percent bonus … deposit'", () => {
    const corpus = corpusTokenSet("you also get a three hundred percent bonus on your next deposit");
    expect(sentenceSaid("Mention the 300% Deposit Bonus", corpus)).toBe(true);
  });
  it("still NOT said when the topic genuinely wasn't mentioned", () => {
    const corpus = corpusTokenSet("hi there, is this a good time to chat?");
    expect(sentenceSaid("Mention the 20 Free Spins", corpus)).toBe(false);
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
