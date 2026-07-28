// VOICE AI CALL SYSTEM RULES & ARCHITECTURE
//
// The rules the backend enforces that are NOT visible as boxes/arrows in the
// Script Builder — surfaced in a hidden-by-default panel so operators can see
// what the engine does on top of the script they draw.
//
// ⚠️ KEEP THIS IN SYNC: whenever the agent/listener/observer behaviour changes
// (a new engine rule, a changed one), update the matching row here in the SAME
// commit. This constant is the single source the Script Builder panel renders.

export type SystemRule = { name: string; spec: string; recent?: boolean };
export type SystemRuleSection = { title: string; subtitle: string; rules: SystemRule[] };

export const SYSTEM_RULES: SystemRuleSection[] = [
  {
    title: "1. Agent Rules",
    subtitle: "Prompt controls — what the model is told to do (it never sees the graph)",
    rules: [
      { name: "Approved Fillers Only", spec: 'May add at most ONE filler per reply from a fixed list ("mm-hmm", "right—", "got it.", "perfect.", "sounds good—"…), and never the same one twice in a call.' },
      { name: "Wait-Phrase Ban", spec: 'Never says "hold on", "one moment", "give me a second", "please hold".' },
      { name: "No Invention", spec: "May only speak authored lines + standing answers + fillers; never invents facts, prices, offers, account activity, or questions." },
      { name: "Verbatim vs Reword", spec: "Verbatim lines said word-for-word; reword lines in its own voice but with facts/numbers/terms exact." },
      { name: "Instruction Execution", spec: 'A line like "Explain that…" / "Mention…" is done in the customer’s language, never read aloud.' },
      { name: "Blend Multi-Part Replies", spec: "Several questions at once → one short combined answer." },
      { name: "Recap, Don’t Repeat", spec: '"Hello? / Are you there?" gets a one-sentence recap, never the whole line again.' },
      { name: "Resume, Don’t Restart", spec: "If cut off mid-reply, continue only the unsaid part." },
      { name: "Pace", spec: "Calm, short sentences, a beat between thoughts, never rush to fit everything in." },
      { name: "SMS Honesty", spec: 'Says the text is "on its way", never "it arrived".' },
      { name: "Greet-by-Name", spec: "The callee’s real first name is substituted into the opening." },
    ],
  },
  {
    title: "2. Listener Rules",
    subtitle: "Webhook engine — turn & flow control",
    rules: [
      { name: "Brief-Ahead", spec: "The next stage’s menu is compiled and pushed while the agent is still talking, so the next turn has zero latency." },
      { name: "Backchannel Gate", spec: 'Short noise ("hello?", "uh-huh") never advances the flow.' },
      { name: "Interruption Arbiter", spec: "If noise cut the agent off mid-line, send it back to finish; late noise gets no nudge." },
      { name: "Speaking Lock", spec: "Never injects a response-triggering line over a mid-sentence agent (prevents the double-intro overlap)." },
      { name: "One Response Per Turn", spec: "If the agent already started replying, the injection continues it — no re-acknowledging, no re-introducing." },
      { name: "Split-Final Merge", spec: "Transcript fragments ~1s apart are treated as one customer turn; only the newest gets a response." },
      { name: "Anti-Repeat Ledger", spec: 'Counts how often each line was delivered; a repeat is downgraded to "shorter, different words".' },
      { name: "Wait-Box Silence Clock", spec: "Advances the silence path after N seconds of total quiet; fires once, never prematurely." },
      { name: "Delivery Watchdog", spec: "If an armed line never actually gets voiced, retrigger once, then log it as undelivered." },
      { name: "Universal Fallback", spec: "If a reply fits no stage path, answer from [Standing Answers] and stay put." },
      { name: "Scoped Classifier", spec: "Two-tier (expected intents first, full vocabulary on escalation), scoped to this script’s intents + collections." },
      { name: "Per-Call Script Resolution", spec: "Each campaign call is bound to its script (assistantId → campaign → script_id), never a global default." },
      { name: "Concurrency Lock", spec: "Two webhooks for the same call can’t both advance the flow (no double-spoken step)." },
      { name: "Voicemail Auto-Hangup", spec: "On a script call, a conclusive answering-machine greeting ends the call instead of letting the agent monologue the offer to a machine (opt-in per campaign).", recent: true },
    ],
  },
  {
    title: "3. Observer Rules",
    subtitle: "Coverage / dedup / required tracking — what stops repetition and forgetting",
    rules: [
      { name: "Covered-Ground Marking", spec: 'A line whose point was already made is tagged "ALREADY COVERED" — strict: the agent must NOT make that point again on its own, not even in different words; a one-sentence recap only if the customer explicitly asks or clearly didn’t hear.', recent: true },
      { name: "Same-Point Dedup (no tag needed)", spec: "Even with no fact: tag, a line is marked covered when every one of its salient sentences has already been spoken — so the SAME point reworded in different words is caught, not just word-for-word restatements.", recent: true },
      { name: "Fact-Level Dedup (fact: tags)", spec: "Once a fact is conveyed under any wording, every sibling line restating it is marked covered (kills paraphrased re-pitches)." },
      { name: "Required-Offer Tracking (must: tags)", spec: 'A required fact not yet said is surfaced as "NOT YET MENTIONED" so the call can’t wrap without it.' },
      { name: "Call Goal Box", spec: "A floating checklist box (no arrows) lists the statements the call must cover, in priority order; the observer tracks each call-wide and won’t let the call end until all are said. The visible way to author the must-say list.", recent: true },
      { name: "Owed-Debts", spec: "Content of boxes the flow already passed that never actually reached the customer comes back as explicit debts." },
      { name: "Script-Scoped Facts", spec: "A must: offer never becomes required for an unrelated campaign’s calls." },
      { name: "Standing Answers", spec: "Every collection the script references is flattened into an always-available off-path answer bank (never advances the plan, never re-answers covered ground)." },
      { name: "Sentence-Level Reconciliation", spec: "The observer diffs the intended line vs what was actually spoken, sentence by sentence, so it knows exactly where the agent stopped." },
      { name: "Unsaid-Tail Re-Serve", spec: "Owed debts and the required offer re-serve only the sentences that weren’t said, never the whole paragraph." },
      { name: "must: Is Spoken-Only", spec: 'A required offer counts as done only when its words truly appear in the transcript (never just because we pushed it); once fully said it flips to "already covered — repeat only if asked".' },
      { name: "End-Node Gate", spec: "At a goodbye box, if the offer is still unsaid, the briefing refuses to let the call close until it’s delivered." },
      { name: "Reword- & Number-Tolerant Matching", spec: 'Detection ignores authoring words ("Mention", "Explain") and matches numbers by meaning ("20" = "twenty", "300%" = "three hundred percent"), so a reworded delivery is correctly recognised as said and the offer isn’t re-ordered.', recent: true },
    ],
  },
];
