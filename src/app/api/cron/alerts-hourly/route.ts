import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../lib/supabaseServer";
import {
  CRON_NAMES,
  CRON_STALENESS_THRESHOLD_SECONDS,
  postSlackAlert,
  recordHeartbeat,
  shouldAlertSpawnFail,
  type CronName,
} from "../../../../lib/alerts/slack";
import crypto from "crypto";

// Read-only SELECT + at most one Slack POST + one heartbeat UPSERT. Well
// under the 30s budget; matches the watchdog/backfill cron pattern.
export const maxDuration = 30;

/**
 * Dedupe window for the `missing` (never-succeeded) bucket. 24h matches the
 * trunk-gate precedent in campaign-scheduler: long enough that a cron blocked
 * on something slow (a DNS change, a parser fix) costs one line a day rather
 * than 24, short enough that it is still on the board every morning.
 */
const MISSING_ALERT_DEDUPE_MS = 24 * 60 * 60 * 1000;

/** alert_state key for the never-succeeded alert about one cron. */
const missingAlertKey = (name: CronName) => `cron_missing:${name}`;

/**
 * GET /api/cron/alerts-hourly
 *
 * Vercel Cron job — runs every hour at :15 past (see vercel.json).
 *
 * Compares cron_heartbeats.last_success_at against per-cron staleness
 * thresholds defined in src/lib/alerts/slack.ts. When a cron's last
 * successful run is older than its threshold, posts a WARN Slack message
 * naming the stale crons. This is the Condition #1 (cron health) checker
 * from the Priority 3 roadmap.
 *
 * Pairs with the existing observability surfaces:
 *   - stuck-slot-watchdog already alerts on pool anomalies (Condition #2)
 *   - campaign-heartbeat already alerts on stuck campaigns + pool drift
 *     (Condition #3 + reconciliation events)
 *
 * Failure-mode design:
 *   - Missing row in cron_heartbeats (cron has never once run to completion):
 *     WARN, same as stale. It used to be INFO-only to dodge a first-deploy
 *     false positive, which made a born-broken cron invisible forever
 *     (VOZ-358 Part 2). One transient first-deploy message is the cheaper
 *     failure mode; it self-clears within one cadence.
 *   - Slack post failures: logged + swallowed by the dispatcher; alerter
 *     still returns its JSON status and records its own heartbeat.
 *   - DB error: 500 response; next tick retries. Self-recovers.
 *
 * Self-monitoring gap (acknowledged tradeoff): alerts-hourly UPSERTs its
 * own heartbeat. If the alerter ITSELF stops running, no Slack alert can
 * fire. Operator notices via absence of expected hourly run cadence over
 * a long horizon. Documented as an open gap in the roadmap; resolving it
 * would require an external monitor outside Voizo.
 *
 * Spam tradeoff: a sustained stale condition produces one identical message
 * per hour until the underlying cron recovers. MVP accepts this; future
 * dedup (last_alerted_at column) is tracked as a roadmap follow-up.
 *
 * Clock-skew note: staleness is computed JS-side using Node's clock for
 * both `last_success_at` (which was written by Node in a prior cron tick)
 * and `now`. A single clock is involved end-to-end, so Postgres/Node skew
 * is irrelevant. NTP keeps Vercel function instances within <1s of each
 * other — far smaller than the smallest 300s threshold.
 *
 * Security: same CRON_SECRET bearer + constant-time compare as siblings.
 *
 * Cost (CLAUDE.md non-negotiable #4):
 *   - Vercel cron: 24 invocations/day, well within Pro plan limits
 *   - Supabase: 1 SELECT + 1 UPSERT per tick — negligible
 *   - Slack: at most 1 POST per tick, bounded by dispatcher's 3s timeout
 *   - No Vapi / Mobivate / SquareTalk calls — zero external spend
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[alerts-hourly] CRON_SECRET not set — rejecting");
    return NextResponse.json({ error: "Not configured" }, { status: 500 });
  }

  const expected = `Bearer ${cronSecret}`;
  const received = authHeader || "";
  if (
    received.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── Query expected crons' heartbeat rows ──
  // Filter to the canonical name list so legacy/unused rows (if any) don't
  // affect the report. Returns a subset if any expected cron has no row yet.
  const expectedNames = Object.values(CRON_NAMES) as CronName[];
  const { data: heartbeats, error: queryErr } = await supabaseAdmin
    .from("cron_heartbeats")
    .select("name, last_success_at")
    .in("name", expectedNames);

  if (queryErr) {
    console.error("[alerts-hourly] cron_heartbeats query failed:", queryErr);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // ── Compute staleness per expected cron ──
  const nowMs = Date.now();
  const heartbeatMap = new Map(
    (heartbeats ?? []).map((h) => [h.name as string, h.last_success_at as string]),
  );

  type CronStatus = {
    name: CronName;
    threshold_seconds: number;
    last_success_at: string | null;
    seconds_since: number | null;
    state: "healthy" | "stale" | "missing";
  };

  const statuses: CronStatus[] = expectedNames.map((name) => {
    const threshold = CRON_STALENESS_THRESHOLD_SECONDS[name];
    const lastIso = heartbeatMap.get(name) ?? null;
    if (!lastIso) {
      return {
        name,
        threshold_seconds: threshold,
        last_success_at: null,
        seconds_since: null,
        state: "missing",
      };
    }
    const lastMs = new Date(lastIso).getTime();
    const secondsSince = Math.round((nowMs - lastMs) / 1000);
    // M3 (audit 2026-06-01): treat corrupt timestamps and future-clock-skewed
    // timestamps as `missing`, not silent-healthy. Without this guard:
    //   - new Date("garbage").getTime() = NaN → NaN > threshold = false → "healthy"
    //   - a far-future last_success_at → secondsSince < 0 → also "healthy"
    // Both mask a real failure.
    if (!Number.isFinite(secondsSince) || secondsSince < 0) {
      console.warn(
        `[alerts-hourly] non-finite or negative secondsSince for ${name} ` +
        `(lastIso=${lastIso}); treating as missing`,
      );
      return {
        name,
        threshold_seconds: threshold,
        last_success_at: lastIso,
        seconds_since: null,
        state: "missing",
      };
    }
    return {
      name,
      threshold_seconds: threshold,
      last_success_at: lastIso,
      seconds_since: secondsSince,
      state: secondsSince > threshold ? "stale" : "healthy",
    };
  });

  const stale = statuses.filter((s) => s.state === "stale");
  const missing = statuses.filter((s) => s.state === "missing");
  const healthy = statuses.filter((s) => s.state === "healthy");

  // ── Slack alert (only when there's something operator-actionable) ──
  // `missing` was INFO-only (console.log, no Slack post) to avoid a
  // first-deploy false positive — a guard with NO EXPIRY. A cron that fails on
  // its very first run therefore never gets a row, never becomes "stale", and
  // stays invisible forever: daily-snapshot burned 40 days and ~40 undelivered
  // stakeholder emails that way (VOZ-358 Part 2, measured 2026-08-18). The
  // guard traded a permanent blind spot on the WORST failure class (born
  // broken) for one transient message on first deploy that self-clears within
  // one cadence. Both buckets now WARN, in ONE post, so a stale cron can no
  // longer mask a never-succeeded one. [[loud-over-silent-skips]]
  const unhealthy = [...stale, ...missing];

  // ── Dedupe the `missing` bucket, and ONLY that bucket ──
  // "Never succeeded" is a state that does not self-clear: the cron stays
  // missing until someone fixes it, so the alert above would repeat every tick
  // for as long as that takes. On 2026-09-17 two crons were in that state at
  // once (daily-snapshot blocked on DNS, mobivate-reconcile on parser defects)
  // — 24 identical messages a day, indefinitely, in the one channel whose job
  // is to make the NEXT silent cron death visible. An alarm nobody can silence
  // is an alarm everybody mutes, which is how this route went blind the first
  // time. `stale` is deliberately NOT deduped: it is a different failure class
  // (a cron that worked and then stopped), it self-clears on recovery, and its
  // hourly cadence is pre-existing accepted behaviour.
  //
  // Keyed per cron, so muting one broken cron can never mute the next one to
  // break. Fail OPEN on the read, mirroring the trunk-gate precedent: a broken
  // dedupe row must not silence a real alert.
  //
  // The explicit `stateErr ||` below is belt-and-braces, verified redundant by
  // mutation on 2026-09-17: a failed PostgREST read also returns data=null, so
  // shouldAlertSpawnFail(null) already returns true and the alert goes out. It
  // is kept because it states the intent, and because the behaviour IS guarded
  // — mutating this loop to `if (stateErr) continue` fails the fail-open test.
  // ponytail: one SELECT per MISSING cron, not one batched .in() — N is the
  // number of broken crons (<=11 today, and exactly 0 on a healthy tick, so a
  // normal hour pays nothing). Batch it if CRON_NAMES ever grows large.
  const missingToPost: CronStatus[] = [];
  let dedupeReadFailures = 0;
  for (const s of missing) {
    const key = missingAlertKey(s.name);
    const { data: state, error: stateErr } = await supabaseAdmin
      .from("alert_state")
      .select("last_alerted_at")
      .eq("key", key)
      .maybeSingle();
    if (stateErr) {
      dedupeReadFailures += 1;
      console.error(
        `[alerts-hourly] alert_state read failed for ${key} (alerting anyway): ${stateErr.message}`,
      );
    }
    const lastAlertedAt = (state?.last_alerted_at as string | null) ?? null;
    if (stateErr || shouldAlertSpawnFail(lastAlertedAt, Date.now(), MISSING_ALERT_DEDUPE_MS)) {
      missingToPost.push(s);
    }
  }

  const toPost = [...stale, ...missingToPost];
  if (toPost.length > 0) {
    const details = toPost.map((s) =>
      s.state === "stale"
        ? `${s.name}: ${s.seconds_since}s since last success (threshold ${s.threshold_seconds}s)`
        : s.last_success_at === null
          ? `${s.name}: NEVER succeeded — no heartbeat row (threshold ${s.threshold_seconds}s)`
          : `${s.name}: unusable last_success_at="${s.last_success_at}" (threshold ${s.threshold_seconds}s)`,
    );
    const accepted = await postSlackAlert(
      "WARN",
      `${toPost.length} cron${toPost.length === 1 ? "" : "s"} unhealthy`,
      details,
    );
    // Stamp only what Slack actually took. Stamping a post that was dropped
    // (webhook down, non-2xx) would swallow the alert for a whole window — the
    // same silent-failure class this route exists to remove. Stricter than the
    // trunk-gate precedent, which stamps unconditionally.
    if (accepted) {
      const nowIso = new Date().toISOString();
      for (const s of missingToPost) {
        const { error: stampErr } = await supabaseAdmin
          .from("alert_state")
          .upsert({ key: missingAlertKey(s.name), last_alerted_at: nowIso }, { onConflict: "key" });
        if (stampErr) {
          console.error(
            `[alerts-hourly] alert_state stamp failed for ${missingAlertKey(s.name)}: ${stampErr.message}`,
          );
        }
      }
    }
  }

  // The dedupe gates the Slack POST alone. Everything below still reports every
  // unhealthy cron, so a quiet channel never means a lying API.
  const missingSuppressed = missing.length - missingToPost.length;

  // Structured summary log for grep / dashboards. `missing_suppressed` is the
  // count that was unhealthy but inside its dedupe window, so a silent hour is
  // still greppable as a deliberate mute rather than looking like a clean tick.
  const summaryLog =
    `[alerts-hourly] healthy=${healthy.length} stale=${stale.length} missing=${missing.length} ` +
    `missing_suppressed=${missingSuppressed} dedupe_read_failures=${dedupeReadFailures}`;
  if (unhealthy.length > 0) {
    console.warn(summaryLog);
  } else {
    console.log(summaryLog);
  }

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.alertsHourly);

  return NextResponse.json({
    severity: unhealthy.length > 0 ? "WARN" : "OK",
    statuses,
    summary: {
      healthy: healthy.length,
      stale: stale.length,
      missing: missing.length,
      missing_suppressed: missingSuppressed,
    },
  });
}
