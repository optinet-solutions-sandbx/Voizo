import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import crypto from "crypto";

// Heartbeat runs every 30 min (vercel.json crons). Per running campaign we
// fire 2 cheap count(*) queries — well under 30s budget for any realistic
// number of concurrent campaigns. The queue gate caps concurrency at 1, so
// in practice this loop runs once per call.
export const maxDuration = 30;

/**
 * GET /api/cron/campaign-heartbeat
 *
 * Vercel Cron job — runs every 30 minutes.
 *
 * Surfaces campaigns that appear "stuck": status='running' but no calls
 * have been created in the last 30 minutes AND there are still pending /
 * pending_retry numbers on the campaign. Common causes:
 *   - FreeSWITCH origination silently failing (no error path back to us)
 *   - Twilio voice-status webhook never firing for the most recent call,
 *     so chainNextCall was never called and the dialer stalled
 *   - Vapi end-of-call webhook lost, leaving a call in_progress forever
 *   - Mobivate-dependent SMS step blocking, halting the chain
 *
 * MVP behavior: detect + log + return a JSON list. No auto-fix. Operator
 * decides whether to pause / resume / investigate. Auto-flipping status
 * is too aggressive given the heuristic could fire on a legitimately-slow
 * campaign (long pending_retry windows, etc.).
 *
 * Pairs with the queue gate (campaign-scheduler + /start endpoint): the
 * gate enforces 1-at-a-time, so a stuck campaign blocks ALL further
 * campaign starts. Heartbeat catches that within 30 minutes.
 *
 * Security: Vercel injects `Authorization: Bearer ${CRON_SECRET}` on
 * cron-triggered requests. Same pattern as campaign-scheduler.
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[campaign-heartbeat] CRON_SECRET not set — rejecting");
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

  // ── Find all running campaigns ──
  const { data: running, error: runningErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, updated_at")
    .eq("status", "running");

  if (runningErr) {
    console.error("[campaign-heartbeat] query error:", runningErr);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!running || running.length === 0) {
    return NextResponse.json({ checked: 0, stuck: [] });
  }

  // ── Per-campaign heuristic ──
  const STALE_WINDOW_MIN = 30;
  const staleThreshold = new Date(Date.now() - STALE_WINDOW_MIN * 60 * 1000).toISOString();

  const stuck: Array<{
    id: string;
    name: string;
    lastUpdated: string;
    pendingNumbers: number;
  }> = [];

  for (const c of running) {
    const campaignId = c.id as string;
    const campaignName = c.name as string;

    // Calls in the stale window?
    const { count: recentCallCount, error: callErr } = await supabaseAdmin
      .from("calls_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .gt("created_at", staleThreshold);

    if (callErr) {
      console.error(`[campaign-heartbeat] call-count error for ${campaignId}:`, callErr);
      continue; // skip this campaign, don't fail the whole sweep
    }

    if (recentCallCount && recentCallCount > 0) continue; // active — not stuck

    // Pending numbers remaining?
    const { count: pendingCount, error: pendErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("outcome", ["pending", "pending_retry"]);

    if (pendErr) {
      console.error(`[campaign-heartbeat] pending-count error for ${campaignId}:`, pendErr);
      continue;
    }

    if (!pendingCount || pendingCount === 0) continue; // no work left — just hasn't auto-completed

    // Stuck: running, has work, no recent activity
    stuck.push({
      id: campaignId,
      name: campaignName,
      lastUpdated: c.updated_at as string,
      pendingNumbers: pendingCount,
    });

    console.warn(
      `[campaign-heartbeat] STUCK: ${campaignName} (${campaignId}) — ` +
      `running with ${pendingCount} pending numbers, no calls in last ${STALE_WINDOW_MIN}m. ` +
      `Operator action needed (pause + investigate, or resume manually).`,
    );
  }

  return NextResponse.json({
    checked: running.length,
    stuck,
    staleWindowMinutes: STALE_WINDOW_MIN,
  });
}
