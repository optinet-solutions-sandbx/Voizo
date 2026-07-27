// Sentence-level delivery reconciliation (VOZ-202/203).
//
// The observer used to judge a line "said" only as a WHOLE — ≥60% of the entire
// line's word-stems present in the transcript. That's blind to a multi-sentence
// line that got cut off partway: "20 free spins. Plus a 300% bonus. I'll text
// you." spoken only up to "20 free spins" reads as <60% → the engine re-serves
// the WHOLE thing (repeat) or, if the fragment happens to clear 60%, marks it
// all done (offer dropped). Neither is right.
//
// These pure helpers let the observer compare the INTENDED line against the
// SPOKEN transcript sentence by sentence, so it knows exactly where the agent
// stopped and what's left — and can re-serve only the unsaid tail. Reword-safe:
// matching is on salient TOKENS (numbers, number-words, significant stems), not
// exact strings, because delivery is reworded.
//
// Pure module (no IO) — unit-tested with relative imports, house convention.

// Sentence/clause boundaries: terminal punctuation, newlines, and em-dash
// clause breaks (authored lines lean on "— …" a lot). Kept simple on purpose;
// over-splitting is harmless (each fragment is still checked for its own tokens),
// under-splitting only loses granularity, never correctness.
export function splitSentences(text: string): string[] {
  return (text || "")
    .split(/(?<=[.!?])\s+|\n+|\s+[—–-]\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Number-words that carry the fact ("twenty free spins", "three hundred percent")
// — digits are dropped by the [a-z] stem regex, so capture them explicitly.
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "percent", "first", "second", "third",
]);

/** The salient tokens of a piece of text: digit-runs, number-words, and
 *  significant word-stems (first 5 chars of words ≥4 letters). This is the unit
 *  of comparison — a sentence "counts as said" when enough of ITS salient tokens
 *  turn up in the transcript, whatever the exact wording. */
export function salientTokens(text: string): string[] {
  const lower = (text || "").toLowerCase();
  const stems = (lower.match(/[a-z]{4,}/g) ?? []).map((w) => (NUMBER_WORDS.has(w) ? w : w.slice(0, 5)));
  const digits = lower.match(/\d+/g) ?? [];
  return [...new Set([...stems, ...digits])];
}

/** Build the transcript's salient-token set once, to test many sentences against. */
export function corpusTokenSet(corpus: string): Set<string> {
  return new Set(salientTokens(corpus));
}

/** Was this sentence delivered? True when ≥60% of its salient tokens are present
 *  in the transcript. Sentences with almost no salient tokens (fillers, "okay so
 *  anyway") return true — we never hold a call open on a contentless fragment. */
export function sentenceSaid(sentence: string, corpusTokens: Set<string>): boolean {
  const toks = salientTokens(sentence);
  if (toks.length < 2) return true;
  const hit = toks.filter((t) => corpusTokens.has(t)).length;
  return hit / toks.length >= 0.6;
}

/** The sentences of `line` that are NOT yet in the transcript, in order — i.e.
 *  the unsaid tail the observer should re-serve (empty ⇒ the whole line landed).
 *  The FIRST entry is effectively "where the agent stopped". */
export function unsaidSentences(line: string, corpusTokens: Set<string>): string[] {
  return splitSentences(line).filter((s) => !sentenceSaid(s, corpusTokens));
}

/** Whole-line delivered? Convenience: no unsaid sentences remain. */
export function lineFullySaid(line: string, corpusTokens: Set<string>): boolean {
  return unsaidSentences(line, corpusTokens).length === 0;
}
