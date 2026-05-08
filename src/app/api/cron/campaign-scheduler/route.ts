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

  // ── Stale in_progress sweeper ──
  // Numbers stuck at outcome='in_progress' fall into 2 categories:
  //   (a) Latest calls_v2 row is terminal AND ended >5 min ago — Vapi end-of-call
  //       was lost or never fired. Resolve to pending_retry (or unreached at max).
  //   (b) NO calls_v2 row at all — fireCall failed AT the INSERT step before any
  //       provider call was made. No actual dial happened, so revert to pending
  //       WITHOUT bumping attempt_count, letting the next cron pick it up cleanly.
  //
  // Per Voizo policy (confirmed with Maria, 2026-05-08): treat ambiguous short
  // calls as "missed" and retry up to max_attempts. Maximizes success rate.
  //
  // Closes adversarial review items C3 (no-calls_v2 stuck), C4/S2 (lost Vapi
  // webhook), and the queue-gate-blocking effect of long-stuck campaigns.
  //
  // Bounded:
  //   - Only running campaigns (per-iter status check)
  //   - .limit(50) on the candidate query
  //   - .eq("outcome", "in_progress") guard on every UPDATE prevents stomping
  //     late-arriving Vapi outcomes (sent_sms / not_interested / declined_offer)
  //   - MIN_GRACE_SEC floor on next_attempt_at prevents tight-loop thrash
  //     when retry_interval_minutes is set to a small value for testing
  const STALE_GRACE_MS = 5 * 60 * 1000;
  const MIN_GRACE_SEC = 60; // floor on next_attempt_at offset (defense vs retry_interval=0 testing)
  const TERMINAL_CALL_STATUSES = ["completed", "no_answer", "busy", "failed", "canceled"];
  const sweepCutoff = new Date(Date.now() - STALE_GRACE_MS).toISOString();

  const { data: stuckCandidates, error: stuckErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("id, campaign_id, attempt_count")
    .eq("outcome", "in_progress")
    .limit(50);

  if (stuckErr) {
    console.error("[scheduler.sweep] stuckCandidates query failed:", stuckErr);
    // Don't fail the whole tick — resume sweep + draft pickup still useful.
  }

  // Per-tick campaign cache: at PoC scale (queue gate=1) all stuck candidates
  // typically share the same campaign_id, so memoizing avoids N+1 round-trips.
  const campaignCache = new Map<string, { status: string; retry_interval_minutes: number; max_attempts: number; name: string } | null>();
  async function getCampaign(campaignId: string) {
    if (campaignCache.has(campaignId)) return campaignCache.get(campaignId)!;
    const { data, error } = await supabaseAdmin
      .from("campaigns_v2")
      .select("status, retry_interval_minutes, max_attempts, name")
      .eq("id", campaignId)
      .single();
    if (error) {
      console.error(`[scheduler.sweep] campaign lookup failed for ${campaignId}:`, error);
      campaignCache.set(campaignId, null);
      return null;
    }
    const row = {
      status: (data?.status as string) ?? "",
      retry_interval_minutes: (data?.retry_interval_minutes as number) ?? 90,
      max_attempts: (data?.max_attempts as number) ?? 3,
      name: (data?.name as string) ?? campaignId,
    };
    campaignCache.set(campaignId, row);
    return row;
  }

  const sweeperResults: Array<{ id: string; result: string }> = [];

  for (const n of stuckCandidates ?? []) {
    const numberId = n.id as string;
    const campaignId = n.campaign_id as string;

    const campaign = await getCampaign(campaignId);
    if (!campaign || campaign.status !== "running") continue;

    // Latest call lookup
    const { data: latestCall, error: callErr } = await supabaseAdmin
      .from("calls_v2")
      .select("status, ended_at")
      .eq("campaign_number_id", numberId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (callErr) {
      console.error(`[scheduler.sweep] latestCall lookup failed for ${numberId}:`, callErr);
      continue;
    }

    // Branch (b): no calls_v2 row at all. fireCall failed at INSERT step before
    // any provider call. No actual dial happened — revert to pending so it can
    // be cleanly re-attempted by the next cron tick or chain-next.
    if (!latestCall) {
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "pending", next_attempt_at: null })
        .eq("id", numberId)
        .eq("outcome", "in_progress");
      console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → pending (no calls_v2 row — fireCall failed pre-INSERT)`);
      sweeperResults.push({ id: numberId, result: "reverted_to_pending" });
      continue;
    }

    // Branch (a): latest call is still in flight → chain-next will handle.
    if (!TERMINAL_CALL_STATUSES.includes(latestCall.status as string)) continue;
    // Branch (a): latest call ended within grace window → wait for Vapi end-of-call.
    if (!latestCall.ended_at || (latestCall.ended_at as string) > sweepCutoff) continue;

    // Branch (a) resolution: at max attempts → unreached; else → pending_retry.
    const attempts = (n.attempt_count as number) ?? 0;
    const maxAttempts = campaign.max_attempts;
    const retryMin = campaign.retry_interval_minutes;

    if (attempts >= maxAttempts) {
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "unreached" })
        .eq("id", numberId)
        .eq("outcome", "in_progress");
      console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → unreached (max attempts)`);
      sweeperResults.push({ id: numberId, result: "unreached_exhausted" });
    } else {
      // Floor next_attempt_at at now + MIN_GRACE_SEC so a same-tick resume sweep
      // can't fire a fresh retry that races a still-in-flight late Vapi webhook.
      const retryMs = Math.max(retryMin * 60 * 1000, MIN_GRACE_SEC * 1000);
      const retryAt = new Date(Date.now() + retryMs).toISOString();
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "pending_retry", next_attempt_at: retryAt })
        .eq("id", numberId)
        .eq("outcome", "in_progress");
      console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → pending_retry @ ${retryAt}`);
      sweeperResults.push({ id: numberId, result: "pending_retry" });
    }
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
      sweepResolved: sweeperResults.length,
      sweeperResults,
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
      sweepResolved: sweeperResults.length,
      sweeperResults,
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
    sweepResolved: sweeperResults.length,
    sweeperResults,
  });
}
