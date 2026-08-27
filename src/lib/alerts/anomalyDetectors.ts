// src/lib/alerts/anomalyDetectors.ts
//
// VOZ-279 platform-wide anomaly detectors, run once per scheduler tick over
// the most recent calls (30-min window, newest-1000 sample — share-based
// thresholds are deliberately clamp-safe at storm volume).
//
// Detector A — AI pipeline burst: the 08-02 OpenAI quota death produced
// ended_reason='pipeline-error-openai-429-exceeded-quota' on 75.6% of calls
// in-window, while the healthy base rate is 0.0% (probe 2026-08-04). A null
// ended_reason means the call never reached Vapi (e.g. CALL_REJECTED) and
// must NOT count toward either side of the share.
//
// Detector B — connect collapse: platform-wide connect share below a floor
// no healthy 30-min bucket approaches. Catches trunk/CID degradation spread
// across campaigns that never hits the per-campaign 15-straight reject
// breaker (rejectBreaker.ts).
//
// Floor raised 0.20 -> 0.50 on 2026-08-18 (SquareTalk AU landline SIP-500
// outage). At 0.20 this predicate tripped in exactly ONE 30-min bucket that
// day — 07:00Z, 46 dials, 4.3% — hours after ~450 dials had already been
// refused. Replaying it over every real 30-min bucket since 08-13 measured:
//   healthy baseline (08-13..08-14, 18 buckets >=20 dials): min 57.5%,
//     p10 73.4%, median 90.6%
//   outage day 08-18: 32.1% platform-wide
// So 0.50 is below every healthy bucket observed (zero false positives in
// that baseline) and catches 08-18 in its FIRST window instead of its fifth;
// it would also have flagged 08-15 07:30Z (49.0%) and 08-17 06:30Z (43.9%),
// three days early. 0.60 was rejected: it false-positives on the healthy
// 08-14 05:00Z bucket (57.5%). Thin baseline (18 buckets / 2 days) — treat as
// WARN, and revisit once a fortnight of clean baseline exists.
//
// Known limitation, deliberately NOT fixed here: this share is platform-wide,
// so a destination-scoped collapse is diluted by healthy traffic. On 08-18 the
// AU landline rate was 5.4% while the platform rate was 31.9%. A per-
// destination-type split is a separate change.
//
// Both are PURE predicates; the scheduler owns querying, dedupe, and Slack.

import { isVoicemail, parseTranscriptTurns } from "../transcriptClassify";
import { resolveSmsConsentMode } from "../smsDispatchDecision";

export const ANOMALY_WINDOW_MINUTES = 30;
export const ANOMALY_ALERT_DEDUPE_MS = 60 * 60 * 1000; // re-alert hourly while it persists

export const AI_BURST_MIN_VAPI_CALLS = 5;
export const AI_BURST_SHARE_THRESHOLD = 0.5;

export const CONNECT_COLLAPSE_MIN_DIALS = 20;
export const CONNECT_COLLAPSE_RATE_THRESHOLD = 0.5;

export interface AiBurstResult {
  trip: boolean;
  /** Calls that reached Vapi (non-null ended_reason). */
  vapiCount: number;
  errCount: number;
  share: number;
}

export function detectAiPipelineBurst(endedReasons: ReadonlyArray<string | null>): AiBurstResult {
  const vapi = endedReasons.filter((r): r is string => r !== null && r !== undefined);
  const err = vapi.filter((r) => r.startsWith("pipeline-error"));
  const share = vapi.length > 0 ? err.length / vapi.length : 0;
  return {
    trip: vapi.length >= AI_BURST_MIN_VAPI_CALLS && share >= AI_BURST_SHARE_THRESHOLD,
    vapiCount: vapi.length,
    errCount: err.length,
    share,
  };
}

export interface ConnectCollapseResult {
  trip: boolean;
  dials: number;
  connected: number;
  rate: number;
}

export function detectConnectCollapse(
  rows: ReadonlyArray<{ hangup_cause: string | null; duration_seconds: number | null }>,
): ConnectCollapseResult {
  const dials = rows.length;
  const connected = rows.filter(
    (r) => r.hangup_cause === "NORMAL_CLEARING" && (r.duration_seconds ?? 0) > 0,
  ).length;
  const rate = dials > 0 ? connected / dials : 1;
  return {
    trip: dials >= CONNECT_COLLAPSE_MIN_DIALS && rate < CONNECT_COLLAPSE_RATE_THRESHOLD,
    dials,
    connected,
    rate,
  };
}

// Detector C — dial silence (VOZ-437): a campaign that is inside its call window,
// has been startable for at least DIAL_SILENCE_MINUTES, holds players who are due
// a call right now, and yet has minted ZERO calls_v2 rows in that time. Detectors
// A and B need dials to exist; this one catches their absence. 2026-08-24 22:32Z →
// 08-25 07:49Z: 8 in-window children sat in 'draft' behind a shut queue gate for
// 16.5h with every cron heartbeat green (VOZ-434) — nothing could fire. The sweep
// runs BEFORE that gate, so this detector is not blinded by the failure it reports.
//
// 15 minutes: the scheduler promotes one draft per ~60s tick and a busy child at
// K=1 dials every ~30s, so a quarter hour of silence with work due is never normal.
// 'paused' children are excluded on purpose — an operator or the reject breaker
// meant that silence, and the breaker posts its own alert. Pure predicate; the
// sweep owns the reads (window check, recent calls, due numbers).

export const DIAL_SILENCE_MINUTES = 15;

export interface DialSilenceCandidate {
  id: string;
  name: string;
  status: string;
  /** Inside its call window both now AND DIAL_SILENCE_MINUTES ago — a child that
   *  just (re-)entered a window has a legitimate gap behind it. */
  inWindowThroughout: boolean;
  /** start_at (today's window open) as epoch ms. */
  startAtMs: number;
  /** calls_v2 rows minted in the last DIAL_SILENCE_MINUTES. */
  recentCalls: number;
  /** Numbers dialable right now — findNextNumber's own eligibility: pending, or
   *  pending_retry whose next_attempt_at has passed, under max_attempts. */
  dueNumbers: number;
}

export interface DialSilenceResult {
  trip: boolean;
  silent: DialSilenceCandidate[];
}

export function detectDialSilence(
  candidates: ReadonlyArray<DialSilenceCandidate>,
  nowMs: number,
): DialSilenceResult {
  const startableSince = nowMs - DIAL_SILENCE_MINUTES * 60 * 1000;
  const silent = candidates.filter(
    (c) =>
      (c.status === "draft" || c.status === "running") &&
      c.inWindowThroughout &&
      c.startAtMs <= startableSince &&
      c.recentCalls === 0 &&
      c.dueNumbers > 0,
  );
  return { trip: silent.length > 0, silent };
}

// ── Detector D — texted a robot (2026-08-27) ─────────────────────────────────
// Every robot ever texted traces to ONE cause: a machine script the label
// classifier had not seen yet. 13 Aug (27 of 53 texts, "please stay on the line")
// was found by hand six days late; Google Call Assist (4 texts) eleven days late.
// This detector re-reads every text sent in the sweep window against three
// signals, so the NEXT unknown script costs a day, not weeks. It only ever
// produces a Slack line — never a dispatch decision — so its rules may be looser
// than isVoicemail's: a false positive costs a glance, a miss costs money.
//
//   classifier  isVoicemail(transcript). Cannot fire on a text the SAME deploy
//               sent (the webhook already refused those); fires when a redeployed
//               classifier recognises what the previous one texted.
//   tripwire    phrases the classifier does not (yet) know. Every entry below was
//               measured reaching a TEXTED call on 2026-08-27.
//   monologue   exactly one substantive customer turn of >= ROBOT_TEXTED_MONOLOGUE_WORDS
//               words. Machines deliver one uninterrupted script; texted humans who
//               stayed on the line produce several short turns. Measured over 3,747
//               texted calls: 938 of 1,573 robots and 80 of 2,174 "humans" — and on
//               reading, nearly all of those 80 were machines the classifier misses.
//
// Modes that text a detected voicemail ON PURPOSE (missed-call follow-up) are
// exempt: a machine text there is policy, not a defect.
export const ROBOT_TEXTED_MONOLOGUE_WORDS = 20;
export const ROBOT_TEXTED_EXEMPT_MODES: readonly string[] = ["registered_optin", "optin_any_pickup"];
const ROBOT_TEXTED_TRANSCRIPT_CAP = 32_000; // same cap as transcriptClassify

export const ROBOT_TEXTED_TRIPWIRES: readonly RegExp[] = [
  /\btrying to reach\b/i, // carrier + call-screen framing
  /\bnot available at (?:this|the) moment\b/i,
  /\bno longer in service\b/i,
  /\bcan'?t take your message\b/i, // "we can't take your message at this time"
  /\bcannot receive messages\b/i, // "this mailbox cannot receive messages"
  /\boperators are busy\b/i,
  /\bhold the line\b/i,
  /\bleave (?:us |me )?a voice message\b/i,
  /\bthe person you (?:have )?called\b/i,
  /\bmailbox\b/i, // isVoicemail needs "mailbox full" / "mailbox number"; alone is enough for a glance
  /\bpress \w+ for\b/i,
];

export interface RobotTextedCandidate {
  smsId: string;
  callId: string;
  campaignName: string;
  /** campaigns_v2.sms_consent_mode, raw — resolved here so NULL reads as verbal_yes (checked), not skipped. */
  mode: string | null | undefined;
  /** The call's transcript TEXT (calls_v2.transcript is jsonb {text}; the sweep unwraps it). */
  transcript: string;
}

export type RobotTextedRule = "classifier" | "tripwire" | "monologue";

export interface RobotTextedOffender extends RobotTextedCandidate {
  rule: RobotTextedRule;
  /** First substantive customer turn, digit runs masked, <= 90 chars — what the machine said. */
  excerpt: string;
}

export interface RobotTextedResult {
  trip: boolean;
  offenders: RobotTextedOffender[];
}

const countWords = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

/** Which rule, if any, says this texted call was a machine. Strongest signal first. */
export function robotTextedRule(transcript: string): RobotTextedRule | null {
  const safe = (transcript ?? "").slice(0, ROBOT_TEXTED_TRANSCRIPT_CAP);
  if (!safe.trim()) return null; // no transcript: nothing to judge (and nothing was textable)
  if (isVoicemail(safe)) return "classifier";
  if (ROBOT_TEXTED_TRIPWIRES.some((re) => re.test(safe))) return "tripwire";
  const userTurns = parseTranscriptTurns(safe)
    .filter((t) => t.speaker === "user" && t.text.trim().length >= 2)
    .map((t) => t.text.trim());
  if (userTurns.length === 1 && countWords(userTurns[0]) >= ROBOT_TEXTED_MONOLOGUE_WORDS) return "monologue";
  return null;
}

export function detectRobotTexted(candidates: ReadonlyArray<RobotTextedCandidate>): RobotTextedResult {
  const offenders: RobotTextedOffender[] = [];
  for (const c of candidates) {
    if (ROBOT_TEXTED_EXEMPT_MODES.includes(resolveSmsConsentMode(c.mode))) continue;
    const rule = robotTextedRule(c.transcript);
    if (!rule) continue;
    const first =
      parseTranscriptTurns((c.transcript ?? "").slice(0, ROBOT_TEXTED_TRANSCRIPT_CAP))
        .find((t) => t.speaker === "user" && t.text.trim().length >= 2)?.text.trim() ?? "";
    offenders.push({ ...c, rule, excerpt: first.replace(/\d{3,}/g, "###").slice(0, 90) });
  }
  return { trip: offenders.length > 0, offenders };
}
