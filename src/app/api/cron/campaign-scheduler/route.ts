import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, hasPendingRetry, isWithinCallWindow } from "@/lib/dialer";
import crypto from "crypto";

// FS bgapi originate takes 8-22s per call. With 60s budget and limit(2),
// we can safely start 2 campaigns per cron tick. Remaining campaigns are
// picked up on the next tick (1 minute later).
export const maxDuration = 60;

/**
 * GET /api/cron/campaign-scheduler
 *
 * Vercel Cron job — runs every minute.
 *
 * Finds campaigns with status='draft', a non-null start_at that has arrived,
 * and auto-starts them. This is the executor half of scheduling; the guard
 * half lives in the /start endpoint (rejects manual Start when start_at is
 * in the future).
 *
 * Security: Vercel injects an Authorization header with CRON_SECRET on
 * cron-triggered requests. We verify it to prevent external triggers.
 *
 * Idempotency: atomic status transition (draft → running) with a WHERE
 * clause prevents double-start if two cron ticks overlap.
 */
export async function GET(request: NextRequest) {
  // ── Auth: verify Vercel cron secret ──
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    console.error("[campaign-scheduler] CRON_SECRET not set — rejecting");
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

  // ── Resume idle running campaigns where retries are due (B2) ──
  // A campaign whose only remaining work is pending_retry sits idle in
  // `running` state. The chain-next webhook can't wake it (no call to chain
  // from), so this sweep handles it: when a retry comes due, fire the next
  // call. Self-heals truly-done campaigns to `completed`.
  //
  // Bounded by:
  //   - max_attempts (default 3) — each number caps at 3 dial attempts
  //   - 1 fire per cron tick per campaign = 60/hr ceiling
  //   - in-flight check — never overlaps an active call
  //   - .limit(1) — defense-in-depth: if the queue gate is ever bypassed
  //     (manual DB edit, race), the resume sweep still won't burn the 60s
  //     function budget on multiple fireCall blocks of 8-22s each.
  const { data: idleRunning, error: idleRunningErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("status", "running")
    .order("updated_at", { ascending: true }) // oldest first → no starvation
    .limit(1);

  if (idleRunningErr) {
    console.error("[scheduler.resume] idleRunning query failed:", idleRunningErr);
    // Don't fail the whole tick — let draft-pickup still run. Resumes catch up next tick.
  }

  const resumeResults: Array<{ id: string; name: string; result: string }> = [];

  for (const campaign of idleRunning ?? []) {
    const campaignId = campaign.id as string;
    const campaignName = campaign.name as string;

    // Skip if a call is in flight — chain-next will handle when it ends
    const { count: inFlight } = await supabaseAdmin
      .from("calls_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .in("status", ["initiated", "ringing", "in_progress", "answered"]);

    if (inFlight && inFlight > 0) continue;

    // Call window check (Manifesto §6: every dial). Outside-window → flip to
    // `paused` for parity with the chain-next webhook (voice-status/route.ts).
    // Without this, the campaign would silently sit in `running` for hours
    // until the window opens — confusing operators and blocking the queue gate.
    const cw = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
    const tz = campaign.timezone as string;
    if (cw && cw.length > 0 && !isWithinCallWindow(cw, tz)) {
      await supabaseAdmin
        .from("campaigns_v2")
        .update({ status: "paused" })
        .eq("id", campaignId)
        .eq("status", "running");
      resumeResults.push({ id: campaignId, name: campaignName, result: "paused_outside_window" });
      continue;
    }

    const next = await findNextNumber(campaignId);
    if (!next) {
      // Nothing due AND nothing waiting → genuinely complete (self-heal).
      // Conditional WHERE status='running' prevents stomping a concurrent
      // operator Pause action.
      if (!(await hasPendingRetry(campaignId))) {
        await supabaseAdmin
          .from("campaigns_v2")
          .update({ status: "completed" })
          .eq("id", campaignId)
          .eq("status", "running");
        resumeResults.push({ id: campaignId, name: campaignName, result: "auto_completed" });
      }
      continue;
    }

    try {
      const host = request.headers.get("host") || "voizo-eight.vercel.app";
      const proto = request.headers.get("x-forwarded-proto") || "https";
      const baseUrl = `${proto}://${host}`;
      await fireCall(
        campaignId,
        next,
        campaign.vapi_assistant_id as string,
        baseUrl,
        (campaign.vapi_sip_uri as string) ?? undefined,
      );
      console.log(`[scheduler.resume] ${campaignName}: fired retry → ${next.phone_e164.slice(0, -4)}****`);
      resumeResults.push({ id: campaignId, name: campaignName, result: "resumed" });
    } catch (err) {
      console.error(`[scheduler.resume] ${campaignName}: fire failed:`, err);
      resumeResults.push({ id: campaignId, name: campaignName, result: "fire_failed" });
    }
  }

  // ── Queue gate: only one campaign runs at a time (MVP constraint) ──
  // Chris's directive 2026-05-07: avoid Vapi/SquareTalk/Mobivate concurrent-load
  // surprises by enforcing serial campaign execution. If another campaign is
  // currently running, defer this tick — the cron fires every minute and the
  // candidate campaign will be picked up once the running one completes.
  // True scaling = additional Vapi accounts or higher subscription tier (Phase 3).
  // Note: this gate fires AFTER the resume sweep above so already-running
  // campaigns can still advance their retries on this tick.
  const { count: runningCount } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id", { count: "exact", head: true })
    .eq("status", "running");

  if (runningCount && runningCount > 0) {
    return NextResponse.json({
      started: 0,
      queued: true,
      reason: "another campaign currently running — deferring to next tick",
      resumed: resumeResults.filter((r) => r.result === "resumed").length,
      resumeResults,
    });
  }

  // ── Find campaigns ready to auto-start ──
  const now = new Date().toISOString();

  const { data: campaigns, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("status", "draft")
    .not("start_at", "is", null)
    .lte("start_at", now)
    .order("start_at", { ascending: true }) // FIFO when multiple are ready
    .limit(1); // queue gate enforces 1-at-a-time; no point picking 2

  if (error) {
    console.error("[campaign-scheduler] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  if (!campaigns || campaigns.length === 0) {
    return NextResponse.json({
      started: 0,
      resumed: resumeResults.filter((r) => r.result === "resumed").length,
      resumeResults,
    });
  }

  const results: Array<{ id: string; name: string; result: string }> = [];

  for (const campaign of campaigns) {
    const campaignId = campaign.id as string;
    const campaignName = campaign.name as string;

    // ── Call window check ──
    const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
    const timezone = campaign.timezone as string;
    if (callWindows && callWindows.length > 0 && !isWithinCallWindow(callWindows, timezone)) {
      console.log(`[campaign-scheduler] ${campaignName}: inside start_at window but outside call window — skipping`);
      results.push({ id: campaignId, name: campaignName, result: "outside_call_window" });
      continue;
    }

    // ── Atomic status transition (draft → running) ──
    const { data: updated, error: updateErr } = await supabaseAdmin
      .from("campaigns_v2")
      .update({ status: "running" })
      .eq("id", campaignId)
      .eq("status", "draft")
      .select("id")
      .single();

    if (updateErr || !updated) {
      results.push({ id: campaignId, name: campaignName, result: "already_started" });
      continue;
    }

    // ── Find next number and fire first call ──
    const nextNumber = await findNextNumber(campaignId);
    if (!nextNumber) {
      // No number eligible right now. If pending_retry numbers exist for the
      // future, keep `running` so the resume sweep can fire them when due.
      if (await hasPendingRetry(campaignId)) {
        results.push({ id: campaignId, name: campaignName, result: "idle_waiting_retry" });
        continue;
      }
      await supabaseAdmin
        .from("campaigns_v2")
        .update({ status: "completed" })
        .eq("id", campaignId)
        .eq("status", "running");
      results.push({ id: campaignId, name: campaignName, result: "no_eligible_numbers" });
      continue;
    }

    try {
      const host = request.headers.get("host") || "voizo-eight.vercel.app";
      const proto = request.headers.get("x-forwarded-proto") || "https";
      const baseUrl = `${proto}://${host}`;

      await fireCall(
        campaignId,
        nextNumber,
        campaign.vapi_assistant_id as string,
        baseUrl,
        (campaign.vapi_sip_uri as string) ?? undefined,
      );

      console.log(`[campaign-scheduler] ${campaignName}: auto-started → dialing ${nextNumber.phone_e164.slice(0, -4)}****`);
      results.push({ id: campaignId, name: campaignName, result: "started" });
    } catch (err) {
      console.error(`[campaign-scheduler] ${campaignName}: fireCall failed:`, err);
      // Match start route + chain-next pattern: don't pause on transient failure.
      // fireCall's catch already flipped the failed number to pending_retry (or
      // unreached at max). The next cron tick (60s) will pick up the next
      // eligible number via the resume sweep. Pause-on-failure was redundant
      // once B2 landed and inconsistent with manual-Start behavior.
      results.push({ id: campaignId, name: campaignName, result: "fire_failed" });
    }
  }

  return NextResponse.json({
    started: results.filter((r) => r.result === "started").length,
    results,
    resumed: resumeResults.filter((r) => r.result === "resumed").length,
    resumeResults,
  });
}
