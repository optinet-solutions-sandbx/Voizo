import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  CRON_NAMES,
  CRON_STALENESS_THRESHOLD_SECONDS,
  postSlackAlert,
  recordHeartbeat,
  type CronName,
} from "@/lib/alerts/slack";
import crypto from "crypto";

// Read-only SELECT + at most one Slack POST + one heartbeat UPSERT. Well
// under the 30s budget; matches the watchdog/backfill cron pattern.
export const maxDuration = 30;

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
 *   - Missing row in cron_heartbeats (e.g., immediately after migration):
 *     treated as INFO, NOT stale. Avoids first-deploy false-positive when
 *     the table is empty. Logged for visibility; no Slack post.
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
  if (stale.length > 0) {
    const details = stale.map(
      (s) =>
        `${s.name}: ${s.seconds_since}s since last success (threshold ${s.threshold_seconds}s)`,
    );
    await postSlackAlert(
      "WARN",
      `${stale.length} cron${stale.length === 1 ? "" : "s"} stale`,
      details,
    );
  } else if (missing.length > 0) {
    // INFO-level: don't escalate to WARN until the operator has had a chance
    // to confirm the missing cron is genuinely failing vs just-deployed.
    // Surfaced in Vercel logs + the JSON response; no Slack post.
    console.log(
      `[alerts-hourly] ${missing.length} crons missing heartbeat rows (first-deploy expected): ${missing.map((s) => s.name).join(", ")}`,
    );
  }

  // Structured summary log for grep / dashboards.
  const summaryLog = `[alerts-hourly] healthy=${healthy.length} stale=${stale.length} missing=${missing.length}`;
  if (stale.length > 0) {
    console.warn(summaryLog);
  } else {
    console.log(summaryLog);
  }

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.alertsHourly);

  return NextResponse.json({
    severity: stale.length > 0 ? "WARN" : missing.length > 0 ? "INFO" : "OK",
    statuses,
    summary: {
      healthy: healthy.length,
      stale: stale.length,
      missing: missing.length,
    },
  });
}
