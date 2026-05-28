import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { CRON_NAMES, postSlackAlert, recordHeartbeat } from "@/lib/alerts/slack";
import crypto from "crypto";

// Read-only watchdog: two short SELECTs + JS-side categorization. Well under
// the 30s budget for any realistic pool size (currently 5 slots; even 500
// would finish in a few hundred ms).
export const maxDuration = 30;

// Anomaly threshold. A leased slot whose owning campaign is paused/completed/
// inactive for this long is suspicious. 24h chosen because legitimate paused
// campaigns waiting for the next call window can sit for 12+ hours (overnight
// pauses, weekend pauses); 24h is long enough to skip those without missing
// slow-burn auto-eject regressions like the [[project_campaign_eject_matrix]]
// gap we discovered on 2026-05-28 (PAUSE_RELEASES_SLOT silently unset for
// ~2 weeks; no surface signal).
const STUCK_THRESHOLD_HOURS = 24;

// Quantitative ALERT trigger. At 5-slot pool capacity (current default),
// 4+ anomalies = pool is nearly exhausted by ghosts. Adjust upward if pool
// capacity grows.
const ALERT_COUNT_THRESHOLD = 4;

// Hard-escalation trigger. Any single stuck lease above this is ALERT
// regardless of how many other anomalies exist. 72h means "this has clearly
// been broken for days; pool capacity is meaningfully degraded."
const ALERT_ESCALATION_HOURS = 72;

type StuckLeaseAnomaly = {
  type: "stuck_lease";
  pool_id: string;
  slot_index: number;
  campaign_id: string;
  campaign_name: string;
  campaign_status: "paused" | "completed" | "inactive";
  leased_at: string;
  hours_leased: number;
};

type OrphanLeaseAnomaly = {
  type: "orphan_lease";
  pool_id: string;
  slot_index: number;
  current_assistant_id: string | null;
  leased_at: string | null;
};

type Anomaly = StuckLeaseAnomaly | OrphanLeaseAnomaly;

type Severity = "OK" | "WARN" | "ALERT";

/**
 * GET /api/cron/stuck-slot-watchdog
 *
 * Vercel Cron job — runs daily at 09:00 UTC (see vercel.json).
 *
 * Watchdog for the auto-eject system. Surfaces two anomaly types:
 *
 *   1. stuck_lease — pool row with status='leased' joined to a campaign with
 *      status IN ('paused','completed','inactive') whose lease is older than
 *      STUCK_THRESHOLD_HOURS. Canonical signal that the auto-eject pipeline
 *      has silently degraded (PAUSE_RELEASES_SLOT misconfig, missing eject on
 *      a new code path, etc.).
 *
 *   2. orphan_lease — pool row with status='leased' but current_campaign_id
 *      IS NULL. The owning campaign was deleted (FK ON DELETE SET NULL) but
 *      the slot wasn't released. Should never happen if eject paths are
 *      correct; filter to the same > 24h threshold to skip ephemeral cases.
 *
 * Why this exists: on 2026-05-28 the team discovered PAUSE_RELEASES_SLOT had
 * been missing from Vercel prod for ~2 weeks. Every flag-gated eject silently
 * no-op'd; the 5-slot pool accumulated stuck leased slots. Found by chance
 * during an audit. This watchdog ensures the next silent regression of the
 * same shape surfaces within 24h via Vercel logs (and via the Priority 3
 * Slack alerting layer once that lands).
 *
 * Read-only: no writes, no side effects. Worst-case failure mode is a 500
 * response and no anomaly surfacing for the day. Identical to the pre-2026-05-28
 * "no watchdog at all" baseline. Zero blast radius on system behavior.
 *
 * Security: same CRON_SECRET bearer pattern as campaign-scheduler / heartbeat
 * / recording-backfill. Constant-time comparison guards against length-based
 * timing attacks on the token.
 *
 * Cost (CLAUDE.md non-negotiable #4):
 *   - Cron: 1 invocation/day, no Vercel budget concern
 *   - Supabase: 2 SELECTs (pool + campaigns_v2 IN-list), milliseconds
 *   - No Vapi / Mobivate / SquareTalk calls — zero external spend
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[stuck-slot-watchdog] CRON_SECRET not set — rejecting");
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

  // ── Query 1: leased slots older than threshold ──
  // Single pass collects both anomaly candidates: orphans (current_campaign_id
  // NULL) and stuck-lease candidates (campaign_id NOT NULL — categorized
  // after we fetch the joined campaign status).
  const thresholdMs = Date.now() - STUCK_THRESHOLD_HOURS * 60 * 60 * 1000;
  const stuckThreshold = new Date(thresholdMs).toISOString();

  const { data: agedLeased, error: slotsErr } = await supabaseAdmin
    .from("vapi_sip_pool")
    .select("id, slot_index, current_campaign_id, current_assistant_id, leased_at")
    .eq("status", "leased")
    .lt("leased_at", stuckThreshold);

  if (slotsErr) {
    console.error("[stuck-slot-watchdog] leased-slot query failed:", slotsErr);
    return NextResponse.json({ error: "DB error (leased slots)" }, { status: 500 });
  }

  const anomalies: Anomaly[] = [];

  // ── Orphan pass: leased + current_campaign_id NULL ──
  for (const slot of agedLeased ?? []) {
    if (slot.current_campaign_id == null) {
      anomalies.push({
        type: "orphan_lease",
        pool_id: slot.id as string,
        slot_index: slot.slot_index as number,
        current_assistant_id: slot.current_assistant_id as string | null,
        leased_at: slot.leased_at as string | null,
      });
    }
  }

  // ── Stuck-lease pass: fetch campaign rows for non-orphan slots ──
  // Postgrest doesn't let us combine a relational filter with a column
  // expression cleanly, so we do a separate IN-list lookup after the slot
  // SELECT. Trivially fast for our pool sizes.
  const campaignIds = (agedLeased ?? [])
    .map((s) => s.current_campaign_id as string | null)
    .filter((id): id is string => id != null);

  if (campaignIds.length > 0) {
    const { data: campaigns, error: campErr } = await supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status")
      .in("id", campaignIds);

    if (campErr) {
      console.error("[stuck-slot-watchdog] campaigns query failed:", campErr);
      return NextResponse.json({ error: "DB error (campaigns)" }, { status: 500 });
    }

    const campaignMap = new Map(
      (campaigns ?? []).map((c) => [c.id as string, c]),
    );

    for (const slot of agedLeased ?? []) {
      if (slot.current_campaign_id == null) continue; // handled as orphan above
      const c = campaignMap.get(slot.current_campaign_id as string);
      // Defensive: FK guarantees the row should exist (with ON DELETE SET NULL
      // the campaign_id is nulled rather than left dangling), but the heartbeat
      // race or a manual SQL DELETE could leave a brief window. Treat as if
      // we found nothing.
      if (!c) continue;
      const campaignStatus = c.status as string;
      if (!["paused", "completed", "inactive"].includes(campaignStatus)) continue;

      const leasedAtStr = slot.leased_at as string;
      const hoursLeased = (Date.now() - new Date(leasedAtStr).getTime()) / (60 * 60 * 1000);

      anomalies.push({
        type: "stuck_lease",
        pool_id: slot.id as string,
        slot_index: slot.slot_index as number,
        campaign_id: c.id as string,
        campaign_name: c.name as string,
        campaign_status: campaignStatus as "paused" | "completed" | "inactive",
        leased_at: leasedAtStr,
        hours_leased: Math.round(hoursLeased * 10) / 10,
      });
    }
  }

  // ── Severity calculation ──
  const stuckCount = anomalies.filter((a) => a.type === "stuck_lease").length;
  const orphanCount = anomalies.filter((a) => a.type === "orphan_lease").length;
  const totalCount = anomalies.length;
  const maxHours = anomalies
    .filter((a): a is StuckLeaseAnomaly => a.type === "stuck_lease")
    .reduce((m, a) => Math.max(m, a.hours_leased), 0);

  let severity: Severity;
  if (totalCount === 0) {
    severity = "OK";
  } else if (totalCount >= ALERT_COUNT_THRESHOLD || maxHours >= ALERT_ESCALATION_HOURS) {
    severity = "ALERT";
  } else {
    severity = "WARN";
  }

  // ── Log surface ──
  // OK is console.log so it doesn't pollute error dashboards; WARN/ALERT use
  // console.warn/error so Vercel and (future) Priority 3 Slack alerting can
  // grep them out reliably.
  const summaryLog =
    `[stuck-slot-watchdog] severity=${severity} stuck=${stuckCount} ` +
    `orphan=${orphanCount} max_hours=${maxHours.toFixed(1)} threshold_hours=${STUCK_THRESHOLD_HOURS}`;

  if (severity === "ALERT") {
    console.error(summaryLog);
  } else if (severity === "WARN") {
    console.warn(summaryLog);
  } else {
    console.log(summaryLog);
  }

  // Per-anomaly detail lines (only when something is wrong). Each line is
  // self-contained so a downstream Slack alerter can post one message per
  // anomaly without re-querying.
  const anomalyDetailLines: string[] = [];
  if (severity !== "OK") {
    const logFn = severity === "ALERT" ? console.error : console.warn;
    for (const a of anomalies) {
      const line =
        a.type === "stuck_lease"
          ? `STUCK slot=${a.slot_index} campaign="${a.campaign_name}" status=${a.campaign_status} hours_leased=${a.hours_leased}`
          : `ORPHAN slot=${a.slot_index} leased_at=${a.leased_at} assistant=${a.current_assistant_id ?? "null"}`;
      logFn(`[stuck-slot-watchdog] ${line}`);
      anomalyDetailLines.push(line);
    }
  }

  // Slack alert on anomaly. severity narrows to "WARN" | "ALERT" inside this
  // branch and matches the slack.ts Severity union. Awaited (not fire-and-forget)
  // so Vercel doesn't suspend the function before the POST completes; the
  // dispatcher's 3s AbortSignal.timeout bounds the wait.
  if (severity !== "OK") {
    const title =
      severity === "ALERT"
        ? `Pool watchdog ALERT: ${totalCount} anomaly/anomalies (max ${maxHours.toFixed(1)}h)`
        : `Pool watchdog WARN: ${totalCount} anomaly/anomalies`;
    await postSlackAlert(severity, title, anomalyDetailLines);
  }

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.stuckSlotWatchdog);
  return NextResponse.json({
    severity,
    anomalies,
    summary: {
      stuck_count: stuckCount,
      orphan_count: orphanCount,
      total_count: totalCount,
      max_hours: maxHours,
      threshold_hours: STUCK_THRESHOLD_HOURS,
      alert_count_threshold: ALERT_COUNT_THRESHOLD,
      alert_escalation_hours: ALERT_ESCALATION_HOURS,
    },
  });
}
