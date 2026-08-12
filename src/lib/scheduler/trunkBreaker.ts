// src/lib/scheduler/trunkBreaker.ts
//
// Trunk-refusal spawn gate. Companion to rejectBreaker.ts (VOZ-278), which stops
// ONE DAY'S CHILD after 15 consecutive rejects. Recurring PARENTS are excluded
// from that breaker — not deliberately, but because campaign-scheduler:370 drops
// campaign_type='recurring' from the idle-running sweep (parents have no
// campaign_numbers_v2 rows, so the self-heal would wrongly complete them). The
// breaker could not trip on a parent regardless: it counts calls_v2 by
// campaign_id and calls belong to the CHILD.
//
// Net effect before this module: every day a fresh child spawned, dialled into a
// dead trunk, tripped the breaker, paused — and repeated. Measured 2026-08-11:
// 107 dials, 0 connects, 4 breaker alerts, every day since 08-08.
//
// This gate skips the daily spawn while the trunk is refusing, EXCEPT for one
// parent that keeps probing. Parents are never paused, because a paused parent
// leaves the spawn loop (it selects status='running') and could then never
// observe recovery — and because "was this paused by the breaker or by an
// operator?" has nowhere to be stored without DDL.
//
// PURE. No I/O — the scheduler owns queries, Slack and dedupe (rejectBreaker pattern).

/** Look-back for the health verdict. Must span from the ~22:31Z spawn back past the
 *  previous day's dialling (~00:01Z, ≈22h earlier); 6h would see zero dials at spawn
 *  time and wrongly read HEALTHY. 26h matches the daily-cron staleness convention in
 *  slack.ts:58. */
export const TRUNK_WINDOW_HOURS = 26;

/** Minimum dials before a verdict is trustworthy. A child that trips the reject
 *  breaker made >= 15 calls, so one probe child clears this comfortably. */
export const TRUNK_MIN_DIALS = 5;

export type TrunkHealth = "HEALTHY" | "REFUSING" | "UNKNOWN";

/**
 * Verdict from COUNTS, never from rows: PostgREST clamps reads at 1000 and a healthy
 * day is ~2,800 dials, so counting fetched rows would silently truncate and could miss
 * the very connects that prove health. The caller supplies two exact-count-head queries.
 *
 * `connected` must be counted as NORMAL_CLEARING **and** duration_seconds > 0 — on
 * 2026-08-06 there were 147 NORMAL_CLEARING rows but only 88 with any audio, so keying
 * on hangup_cause alone reads a collapsing trunk as healthy.
 */
export function assessTrunkHealth(
  counts: { dials: number; connected: number },
  minDials: number = TRUNK_MIN_DIALS,
): TrunkHealth {
  // FAIL OPEN: too little evidence is never a reason to hold spawns.
  if (counts.dials < minDials) return "UNKNOWN";
  if (counts.connected > 0) return "HEALTHY";
  return "REFUSING";
}

export interface ParentProbeCandidate {
  id: string;
  /**
   * ISO start_at of this parent's most recent non-'skipped' child that started
   * STRICTLY BEFORE the current spawn day — never a child spawned for today.
   *
   * ⚠️ This restriction is the whole correctness argument, and omitting it took
   * production down on 2026-08-12. Ranking is by this value, so if the caller
   * includes TODAY's child then a spawn CHANGES ITS OWN SORT KEY: tick 1 picks
   * parent A (oldest newest-child) and A spawns; tick 2 sees A holding today's
   * child, ranks it last, and hands the probe slot to B, which spawns; and so on
   * until every parent has spawned. The gate then does the opposite of its job —
   * measured 4 spawns and 1,660 dials instead of 1 spawn and ~15-20.
   *
   * Excluding today's children makes the key IMMUTABLE for the whole day (a
   * spawn cannot change any parent's pre-today newest child), so the pick is
   * stable across ticks while still rotating day to day.
   */
  newestChildStartAt: string | null;
}

// NOTE: this module is now READ-ONLY advice. The scheduler's skip path used to also
// release the prior child's SIP slot; that write was REMOVED 2026-08-12 after it
// stripped a just-spawned child's assistant and SIP URI and latched the dialer into
// placing zero calls. See the comment at the skip path in campaign-scheduler/route.ts.
// Keep it that way: a gate that only decides can slow calling down, but a gate that
// writes can stop it dead.

/**
 * While the trunk is refusing, exactly ONE parent still spawns so we keep a recovery
 * signal — if nothing dials, "is the trunk refusing?" becomes unanswerable and the gate
 * oscillates with a one-day period.
 *
 * Choice = the parent whose most recent PRE-TODAY child is oldest. Derived from existing
 * rows, so there is no counter to drift, and it ROTATES by itself: today's prober becomes
 * the newest, so tomorrow a different parent takes the slot. Over four days each of the
 * four AU parents probes once, which also spreads the probe across segments and numbers.
 *
 * A parent that has never spawned sorts FIRST (most overdue). Ties break by id.
 *
 * ⚠️ Determinism across ticks requires BOTH halves: the id tiebreak AND the caller
 * feeding only pre-today children (see `newestChildStartAt`). The id tiebreak alone was
 * believed sufficient and was not — a stable tiebreak on a key that a spawn mutates
 * still yields a different winner every tick. That gap is the 2026-08-12 regression.
 */
export function selectProbeParent(
  candidates: ReadonlyArray<ParentProbeCandidate>,
): string | null {
  if (candidates.length === 0) return null;
  const sorted = [...candidates].sort((a, b) => {
    if (a.newestChildStartAt === b.newestChildStartAt) return a.id.localeCompare(b.id);
    if (a.newestChildStartAt === null) return -1;
    if (b.newestChildStartAt === null) return 1;
    return a.newestChildStartAt.localeCompare(b.newestChildStartAt);
  });
  return sorted[0].id;
}
