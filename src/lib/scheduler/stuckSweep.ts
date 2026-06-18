// Status-aware resolution for the campaign-scheduler's stale-`in_progress` sweeper.
//
// A number sits at campaign_numbers_v2.outcome='in_progress' while a dial is live
// (or after the end-of-call webhook intentionally parked a voicemail-hit number for
// retry). The sweeper resolves the stragglers. It USED to resolve only `running`
// campaigns, which stranded every in_progress number on a paused/completed/inactive
// campaign forever (P2 data-accuracy bug, 2026-06-17). This decides the resolution
// per campaign status:
//   - running / paused (will dial again) → normal resolution (pending / pending_retry
//     / unreached-at-max). Paused numbers dial when the campaign resumes, which
//     RESTORES Maria's 3×90min voicemail-retry policy that the old gate denied.
//   - completed / inactive / anything else (never dials again) → terminal `unreached`
//     (never pending_retry — a retry that can never fire is just a different limbo).
//
// Pure + side-effect-free (no mutation, no supabase, no Date.now) so it unit-tests
// without the env-throwing service-role singleton — same pattern as draftPriority.ts.
// The caller owns every DB write, the >5-min grace cutoff, and the retry timing.

// calls_v2.status values that mean the call is OVER (vs initiated/ringing/answered/
// in_progress, which are still live). Mirrors the dialer's terminal set.
export const TERMINAL_CALL_STATUSES: string[] = [
  "completed",
  "no_answer",
  "busy",
  "failed",
  "canceled",
];

// Campaign statuses whose in_progress numbers will still be dialed. `paused` is
// resumable (the start route accepts only draft|paused); everything not in this set
// is terminal for sweep purposes and resolves to `unreached`.
const RESUMABLE_CAMPAIGN_STATUSES: ReadonlySet<string> = new Set(["running", "paused"]);

export type StuckSweepAction =
  | "skip" // latest call still live (and recent), or ended within the grace window — wait
  | "pending" // resumable campaign, no calls_v2 row (fireCall failed pre-INSERT) — re-queue
  | "pending_retry" // resumable campaign, terminal call, under max_attempts — retry per policy
  | "unreached_max" // resumable campaign, terminal call, at/over max_attempts — terminal
  | "unreached_terminal" // non-resumable campaign — terminal, will never dial these again
  | "reap_pending" // resumable, latest call FROZEN non-terminal past the stale floor — mark call dead + re-queue
  | "reap_unreached"; // non-resumable, latest call frozen non-terminal past the stale floor — mark call dead + terminal

export interface StuckSweepInput {
  /** campaigns_v2.status of the owning campaign. */
  campaignStatus: string;
  /** Most recent calls_v2 row for the number, or null if none exists. */
  latestCall: { status: string; ended_at: string | null; created_at: string | null } | null;
  /** campaign_numbers_v2.attempt_count. */
  attemptCount: number;
  /** campaigns_v2.max_attempts. */
  maxAttempts: number;
  /** ISO string: a terminal call that ended AFTER this is still within the grace window. */
  sweepCutoffIso: string;
  /**
   * ISO string: a NON-terminal call CREATED at or before this is frozen/dead and gets
   * reaped (P2b). Set well above any real call's lifetime (Vapi hard-caps calls at 180s),
   * so a genuinely-live call is never reaped.
   */
  staleCutoffIso: string;
}

export function decideStuckResolution(input: StuckSweepInput): StuckSweepAction {
  const { campaignStatus, latestCall, attemptCount, maxAttempts, sweepCutoffIso, staleCutoffIso } = input;
  const resumable = RESUMABLE_CAMPAIGN_STATUSES.has(campaignStatus);

  // No call row: fireCall failed before the INSERT step — no provider call was ever
  // made. Resumable → revert to pending for a clean re-attempt; terminal → unreached.
  if (!latestCall) {
    return resumable ? "pending" : "unreached_terminal";
  }

  // Latest call still has a non-terminal status.
  if (!TERMINAL_CALL_STATUSES.includes(latestCall.status)) {
    // Frozen past the staleness floor (e.g. stuck at `initiated` for months because the
    // status webhook was lost) → the call is dead; reap it (P2b). The number resolves and
    // the dead row is marked terminal so the resume-sweep in-flight guard stops counting
    // it. Unknown age (no created_at) → never reap.
    if (latestCall.created_at && latestCall.created_at <= staleCutoffIso) {
      return resumable ? "reap_pending" : "reap_unreached";
    }
    // Recent → may still be live; the chain-next / end-of-call webhook will resolve it.
    return "skip";
  }

  // Ended within the grace window → wait for a possibly-late Vapi end-of-call webhook
  // (applies to terminal campaigns too — never stomp a still-arriving real outcome).
  if (!latestCall.ended_at || latestCall.ended_at > sweepCutoffIso) return "skip";

  // Terminal call, grace passed.
  if (!resumable) return "unreached_terminal";
  return attemptCount >= maxAttempts ? "unreached_max" : "pending_retry";
}
