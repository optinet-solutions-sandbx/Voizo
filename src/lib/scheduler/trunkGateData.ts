// src/lib/scheduler/trunkGateData.ts
//
// VOZ-371: the trunk gate's DATA-GATHERING half, extracted from
// campaign-scheduler/route.ts so it can be tested against fakes.
//
// ── Why this file exists ────────────────────────────────────────────────────
// On 2026-08-11 the trunk gate shipped with 13 passing unit tests over
// assessTrunkHealth + selectProbeParent, and BOTH functions were correct. The
// defect was in the route's QUERIES around them:
//   · the newest-child lookup omitted `.lt("start_at", dayStart)`, so a spawn
//     could change its own ranking key → a different probe winner every tick →
//     all four parents spawned (VOZ-368: 4 spawns, 2,027 dials, none connecting);
//   · the dials count omitted `.not("provider_call_id","is",null)`, so dials that
//     died BEFORE FreeSWITCH counted as trunk evidence and pinned the verdict at
//     REFUSING instead of failing open (VOZ-372).
// A pure-function suite cannot see either. The queries had to move somewhere a
// test can watch them being built — that is the whole point of the seam.
//
// Behaviour is a verbatim move of route.ts lines ~1029-1138 (2026-08-14) — same
// queries, same filters, same fail-open branches, same log strings — with ONE
// deliberate deviation: a single injected clock. The old code captured a second
// `new Date()` AFTER the count queries resolved and fed it to the day boundary,
// so near a parent's local midnight the count window and the day boundary could
// derive from different days; here one `now` feeds both, which is what makes the
// function testable and keeps each tick internally coherent. Two later commits
// harden inherited gaps the review exposed (null counts and invalid-timezone
// throws fail OPEN instead of failing closed / killing the tick). The route's
// skip list stays in the route (it needs parent names and the spawn loop), so
// the seam is exactly `{ health, probeParentId }` — the two values the spawn
// loop reads.
//
// READ-ONLY BY CONTRACT. The gate must never write: on 2026-08-12 the skip path
// released the prior child's SIP slot, which stripped a just-spawned child's
// assistant + SIP URI and latched the dialer into placing zero calls. The
// interface below exposes no mutating verb, and a test asserts no write is
// attempted.

import {
  assessTrunkHealth,
  selectProbeParent,
  TRUNK_WINDOW_HOURS,
  type TrunkHealth,
} from "./trunkBreaker";
import { startOfDayIsoInTz } from "./recurringSpawn";

/** Shapes PostgREST returns for the two query kinds this gate makes. */
export interface GateCountResult {
  count: number | null;
  error: { message: string } | null;
}
export interface GateRowResult {
  data: { start_at?: string | null } | null;
  error: { message: string } | null;
}

/**
 * The MINIMAL slice of the Supabase query builder the gate uses — read verbs
 * only, deliberately. A count query is awaited directly (the real builder is a
 * thenable); the child lookup ends in maybeSingle().
 */
export interface GateBuilder extends PromiseLike<GateCountResult> {
  select(columns: string, opts?: { count?: "exact"; head?: boolean }): GateBuilder;
  eq(column: string, value: unknown): GateBuilder;
  neq(column: string, value: unknown): GateBuilder;
  gt(column: string, value: unknown): GateBuilder;
  gte(column: string, value: unknown): GateBuilder;
  lt(column: string, value: unknown): GateBuilder;
  not(column: string, operator: string, value: unknown): GateBuilder;
  order(column: string, opts: { ascending: boolean }): GateBuilder;
  limit(n: number): GateBuilder;
  maybeSingle(): PromiseLike<GateRowResult>;
}
export interface GateDb {
  from(table: string): GateBuilder;
}

/** Only the parent fields the gate reads. */
export interface TrunkGateParent {
  id: string;
  timezone: string | null;
}

export interface TrunkGateResult {
  health: TrunkHealth;
  /** The one parent allowed to spawn while REFUSING; null unless REFUSING. */
  probeParentId: string | null;
}

/** console-shaped sink so tests can assert the fail-open reason without noise. */
export interface GateLog {
  log: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Resolve the trunk gate: how healthy is the trunk, and if it is refusing,
 * which single parent keeps probing?
 *
 * FAILS OPEN by design (opposite of the VOZ-364 suppression gate): a wrong
 * REFUSING verdict stops all calling, which is far worse than the ~90 free
 * rejected dials it saves. Any error ⇒ UNKNOWN ⇒ every parent spawns.
 */
/**
 * ⚠️ `now` IS ASYMMETRIC, and that is inherited behaviour, not an oversight here.
 * The child/day half honours it fully (startOfDayIsoInTz), but the count half only
 * bounds the window's LOWER edge (`created_at >= now − 26h`) — exactly as the route
 * did. So calling this with a PAST `now` does NOT replay that moment: the counts run
 * through to the real present. Measured 2026-08-14 while verifying this extraction —
 * a live call with now=2026-08-11T22:31Z returned HEALTHY, while the same window with
 * an upper bound is 107 dials / 0 connects = REFUSING.
 *
 * Deliberately NOT fixed in the same change as the extraction (VOZ-371 is a test
 * harness, not a behaviour change), and a unit test pins it so adding an upper bound
 * has to be a decision. Adding `lt("created_at", now)` would also make the two counts
 * share one upper edge — today a row landing between the two parallel queries can be
 * counted by one and missed by the other.
 */
export async function resolveTrunkGate(
  db: GateDb,
  parents: readonly TrunkGateParent[],
  now: Date,
  log: GateLog = console,
): Promise<TrunkGateResult> {
  // Counts, not rows: PostgREST clamps reads at 1000 and 08-01 was 2,828 dials.
  const trunkSince = new Date(now.getTime() - TRUNK_WINDOW_HOURS * 3_600_000).toISOString();
  const [dialsRes, connectedRes] = await Promise.all([
    db
      .from("calls_v2")
      .select("id", { count: "exact", head: true })
      .gte("created_at", trunkSince)
      // VOZ-372: only dials that REACHED the trunk are evidence about the trunk.
      // fireCall sets provider_call_id only after originateCall resolves, so NULL
      // means the call never got as far as FreeSWITCH — it says nothing about
      // SquareTalk. On 2026-08-12 all 2,027 dials failed before FreeSWITCH and
      // every one still counted here, which held `dials >= TRUNK_MIN_DIALS` and
      // pinned the verdict at REFUSING instead of letting it fall back to UNKNOWN
      // (fail-open). Measured: 0/2027 had a provider_call_id that day, while
      // 107/107 of 08-11's genuine carrier refusals did — so this filter removes
      // the junk without blinding the gate to a real refusal.
      .not("provider_call_id", "is", null),
    db
      .from("calls_v2")
      .select("id", { count: "exact", head: true })
      .gte("created_at", trunkSince)
      // Same definition as detectConnectCollapse. duration_seconds > 0 is
      // load-bearing: 2026-08-06 had 147 NORMAL_CLEARING rows but only 88 with
      // audio, so hangup_cause alone reads a dead trunk as healthy.
      .eq("hangup_cause", "NORMAL_CLEARING")
      .gt("duration_seconds", 0),
  ]);

  let health: TrunkHealth = "UNKNOWN";
  if (dialsRes.error || connectedRes.error) {
    log.error(
      "[scheduler.trunkGate] count query failed — FAILING OPEN (all parents spawn):",
      dialsRes.error?.message ?? connectedRes.error?.message,
    );
    return { health, probeParentId: null };
  }
  if (dialsRes.count === null || connectedRes.count === null) {
    // A null count WITHOUT an error (Content-Range header absent or stripped by
    // a proxy) must not coerce to 0: dials→0 would fail open anyway, but
    // connected→0 fails CLOSED — a false REFUSING on a healthy trunk, the one
    // direction this gate must never fail (review 2026-08-14). Treat it as the
    // error it is.
    log.error(
      "[scheduler.trunkGate] count query returned null count — FAILING OPEN (all parents spawn)",
    );
    return { health, probeParentId: null };
  }
  health = assessTrunkHealth({
    dials: dialsRes.count,
    connected: connectedRes.count,
  });
  log.log(
    `[scheduler.trunkGate] ${health} — ${connectedRes.count ?? 0} connected of ` +
      `${dialsRes.count ?? 0} dials in the last ${TRUNK_WINDOW_HOURS}h`,
  );
  if (health !== "REFUSING") return { health, probeParentId: null };

  // Newest PRE-TODAY child per parent — the probe pick's ranking key. Queried
  // per parent with limit(1) rather than one big .in() — children accumulate
  // daily and a pooled read would hit the 1000-row clamp within months.
  //
  // `.lt("start_at", dayStart)` is load-bearing, and omitting it IS the
  // 2026-08-12 regression (4 spawns, 1,660 dials, all calling dead): the pick
  // ranks by this start_at, so including today's child lets a spawn change its
  // OWN sort key — the winner then moves every tick and each parent spawns in
  // turn. Excluding today makes the key immutable for the whole day, so the pick
  // holds across ticks and still rotates day to day. Same day DEFINITION as
  // spawnChildIfDue's idempotency check (startOfDayIsoInTz), though the two are
  // evaluated on clocks captured moments apart — a tick straddling a parent's
  // local midnight can disagree with spawnChildIfDue for that one tick.
  const newestPreTodayChildStartAt = new Map<string, string | null>();
  for (const p of parents) {
    // FAIL OPEN on a missing timezone. startOfDayIsoInTz throws a RangeError on
    // a null tz (Intl rejects it), and an uncaught throw HERE would kill the
    // whole tick — no spawns, no heartbeat, no last-resort sweep — for every
    // parent, not just the broken one. Today such a parent merely returns
    // spawn_failed, so throwing would be strictly worse.
    if (!p.timezone) {
      log.error(`[scheduler.trunkGate] parent ${p.id} has no timezone — FAILING OPEN`);
      return { health: "UNKNOWN", probeParentId: null };
    }
    // A truthy-but-INVALID IANA name ("Australia/Sidney", "AEST") makes Intl
    // throw a RangeError inside startOfDayIsoInTz. Uncaught, that 500s the whole
    // tick every minute — no spawns, no heartbeat, no last-resort sweep — until
    // the row is fixed; the null-guard above only covers a MISSING timezone.
    // Fail open like every other error path (review 2026-08-14; the old inline
    // code inherited this throw — hardened here, deliberately, as its own commit).
    let dayStart: string;
    try {
      dayStart = startOfDayIsoInTz(now, p.timezone);
    } catch (e) {
      log.error(
        `[scheduler.trunkGate] parent ${p.id} has invalid timezone ${JSON.stringify(p.timezone)} — FAILING OPEN:`,
        e instanceof Error ? e.message : e,
      );
      return { health: "UNKNOWN", probeParentId: null };
    }
    const { data: child, error: childErr } = await db
      .from("campaigns_v2")
      .select("start_at")
      .eq("parent_campaign_id", p.id)
      .neq("status", "skipped")
      .lt("start_at", dayStart)
      .order("start_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (childErr) {
      // FAIL OPEN: without a reliable probe pick we must not hold spawns.
      log.error(
        `[scheduler.trunkGate] newest-child lookup failed for ${p.id} — FAILING OPEN:`,
        childErr.message,
      );
      return { health: "UNKNOWN", probeParentId: null };
    }
    newestPreTodayChildStartAt.set(p.id, child?.start_at ?? null);
  }

  const probeParentId = selectProbeParent(
    parents.map((p) => ({
      id: p.id,
      newestChildStartAt: newestPreTodayChildStartAt.get(p.id) ?? null,
    })),
  );
  log.log(`[scheduler.trunkGate] holding daily spawns; probe parent = ${probeParentId ?? "(none)"}`);
  return { health, probeParentId };
}
