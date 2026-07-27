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

// Numbers are DROPPED from the salient set (VOZ-229): a goal authored with a
// digit ("20 free spins", "300% bonus") never matches the spoken number-WORD
// ("twenty", "three hundred percent"), and vice-versa — so a number would
// falsely read as "not said" and the observer would keep re-ordering the offer.
// The surrounding content words ("free spins", "deposit bonus") carry the topic;
// "was this fact mentioned?" doesn't need digit-exact matching.
const NUMBER_WORDS = new Set([
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
  "eighty", "ninety", "hundred", "thousand", "percent", "first", "second", "third",
]);

// STOPWORDS (5-char stems) that appear in AUTHORED goal/statement text but that
// a live agent never actually speaks — authoring/instruction verbs ("Mention
// the…", "Explain that…") and low-content function words. Counting them as
// required tokens dragged real deliveries below the match threshold (VOZ-229:
// "Mention the 20 Free Spins" scored 2/4 and re-fired though the agent said it).
const STOPWORD_STEMS = new Set([
  // authoring / instruction verbs
  "menti", "expla", "remin", "confi", "ensur", "tell", "discu", "share", "state", "descr", "instr",
  // low-content function words (>=4 chars)
  "that", "this", "these", "those", "with", "your", "have", "will", "woul", "from", "into", "onto",
  "just", "been", "bein", "when", "what", "whic", "also", "make", "sure", "want", "need", "well",
  "they", "them", "then", "than", "ther", "thei", "abou", "here", "gonna", "some", "only", "more", "very",
]);

/** The salient tokens of a piece of text: significant word-stems (first 5 chars
 *  of words ≥4 letters) MINUS numbers and authoring/function stopwords, PLUS
 *  short all-caps acronyms (SMS, VIP) the stemmer would otherwise drop. This is
 *  the unit of comparison — a sentence "counts as said" when enough of ITS
 *  salient tokens turn up in the transcript, whatever the exact wording. */
export function salientTokens(text: string): string[] {
  const raw = text || "";
  // Acronyms captured from the ORIGINAL casing (2–5 uppercase letters) before
  // lowercasing — "SMS"/"VIP" are strong fact tokens shorter than the 4-char cut.
  const acronyms = (raw.match(/\b[A-Z]{2,5}\b/g) ?? []).map((a) => a.toLowerCase());
  const stems = (raw.toLowerCase().match(/[a-z]{4,}/g) ?? [])
    .filter((w) => !NUMBER_WORDS.has(w))
    .map((w) => w.slice(0, 5))
    .filter((s) => !STOPWORD_STEMS.has(s));
  return [...new Set([...stems, ...acronyms])];
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
