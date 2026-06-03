// Shared transcript classification for the Reviews queue.
//
// Speaker parsing + voicemail patterns are ported from the end-of-call webhook
// (src/app/api/webhooks/vapi/end-of-call/route.ts). Kept as a SEPARATE copy on
// purpose: that webhook is call-path code we don't disturb for a slice-1 feature.
// TODO (separate, reviewed change): DRY the webhook to import from here.

export type TranscriptSpeaker = "ai" | "user" | "unknown";
export interface TranscriptTurn {
  speaker: TranscriptSpeaker;
  text: string;
}

const TRANSCRIPT_CAP = 32_000;

/**
 * Parse Vapi's flat, speaker-labelled transcript into ordered turns. Handles
 * both observed formats — "User\n[text]" and "User: [text]" — and skips stray
 * timestamp lines like "4:48:40 PM(+00:00.61)".
 */
export function parseTranscriptTurns(transcript: string): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  const lines = transcript.split(/\r?\n/);
  let currentSpeaker: TranscriptSpeaker = "unknown";
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join(" ").trim();
    if (text) turns.push({ speaker: currentSpeaker, text });
    buffer = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (/^\d{1,2}:\d{2}(:\d{2})?\s*(AM|PM)?(\s*\(\+?[\d:.]+\))?$/i.test(line)) continue;

    if (/^(?:AI|Assistant|Bot)$/i.test(line)) { flush(); currentSpeaker = "ai"; continue; }
    if (/^(?:User|Customer|Caller|Human)$/i.test(line)) { flush(); currentSpeaker = "user"; continue; }

    const aiInline = line.match(/^(?:AI|Assistant|Bot):\s*(.*)$/i);
    if (aiInline) { flush(); currentSpeaker = "ai"; if (aiInline[1]) buffer.push(aiInline[1]); continue; }
    const userInline = line.match(/^(?:User|Customer|Caller|Human):\s*(.*)$/i);
    if (userInline) { flush(); currentSpeaker = "user"; if (userInline[1]) buffer.push(userInline[1]); continue; }

    buffer.push(line);
  }
  flush();
  return turns;
}

// Voicemail / answering-machine detection — TWO tiers. Short AU "message bank"
// greetings (e.g. "This message bank is full.") emit only 0-1 generic matches and
// slipped the >=2 threshold below, surfacing as FAKE "real conversations" in
// /reviews (campaign 9df71cd3, 2026-06-03). The strong tier fixes that.
//
// STRONG — unambiguous machine phrases a live customer would never utter on a
// sales call; a SINGLE match is conclusive.
const VOICEMAIL_STRONG_PATTERNS = [
  /\bvoice\s*mail\b/i,
  /\bvoicemail\b/i,
  /\bmessage bank\b/i, // AU/UK term for voicemail — the 2026-06-03 miss
  /(?:finished|done) recording/i, // "when you have finished recording, you may hang up"
  /leave (?:a |your )?(?:detailed |brief |short )?message (?:after|at)\b/i, // "leave a detailed message after the tone"
  /can'?t take your call/i,
  /please record (?:your )?message/i,
];

// WEAK — generic greeting fragments that can appear incidentally in a real call.
// 2+ distinct matches = voicemail (a real customer rarely emits two; a greeting emits 3-5).
const VOICEMAIL_GREETING_PATTERNS = [
  /\bleave (?:a |your )?message\b/i,
  /after the (?:tone|beep)/i,
  /at the sound of the (?:tone|beep)/i,
  /\bpress (?:1|hash|pound|star)/i,
  /\byou'?ve reached\b/i,
  /\bnot available\b/i,
];

export function isVoicemail(transcript: string): boolean {
  if (!transcript) return false;
  const safe = transcript.slice(0, TRANSCRIPT_CAP);
  if (VOICEMAIL_STRONG_PATTERNS.some((p) => p.test(safe))) return true;
  return VOICEMAIL_GREETING_PATTERNS.filter((p) => p.test(safe)).length >= 2;
}

/**
 * The Reviews-queue inclusion rule (confirmed with Jasiel 2026-06-02):
 * keep a call iff there was a REAL conversation with the customer —
 *   • at least one substantive customer (user) turn,
 *   • NOT a voicemail greeting,
 *   • NOT just the AI's opening line (which yields zero user turns).
 * Goal-reached is irrelevant here; an unconverted-but-real conversation stays.
 */
export function hasRealConversation(transcript: string | null | undefined): boolean {
  if (!transcript || !transcript.trim()) return false;
  if (isVoicemail(transcript)) return false;
  const turns = parseTranscriptTurns(transcript);
  return turns.some((t) => t.speaker === "user" && t.text.trim().length >= 2);
}
