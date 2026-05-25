import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, hasPendingRetry, isWithinCallWindow } from "@/lib/dialer";
import { spawnChildIfDue, type RecurringParent, type SpawnOutcome } from "@/lib/scheduler/recurringSpawn";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { pauseReleasesSlot } from "@/lib/featureFlags";
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
    .neq("campaign_type", "recurring") // Recurring parents have no campaign_numbers_v2 rows by
                                       // design — they're schedule definitions, not dial lists.
                                       // Without this filter the self-heal at line 240 would
                                       // flip them to 'completed' on the next tick.
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
    //
    // When PAUSE_RELEASES_SLOT is on (Phase 1+), also clear Vapi pointers
    // and release the slot via the shared helper, so the cron gate's
    // leased-slot count reflects actual occupancy (paused campaigns no
    // longer pin a worker).
    const cw = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
    const tz = campaign.timezone as string;
    if (cw && cw.length > 0 && !isWithinCallWindow(cw, tz)) {
      const releaseOnPause = pauseReleasesSlot();
      const capturedAssistantId = campaign.vapi_assistant_id as string | null;
      const capturedSlotId = campaign.vapi_pool_slot_id as string | null;

      const updatePayload: Record<string, unknown> = { status: "paused" };
      if (releaseOnPause) {
        updatePayload.vapi_assistant_id = null;
        updatePayload.vapi_pool_slot_id = null;
        updatePayload.vapi_sip_uri = null;
        updatePayload.last_paused_at = new Date().toISOString();
      }

      const { data: pausedUpdate } = await supabaseAdmin
        .from("campaigns_v2")
        .update(updatePayload)
        .eq("id", campaignId)
        .eq("status", "running")
        .select("id")
        .single();

      let resultLabel = "paused_outside_window";
      if (pausedUpdate && releaseOnPause) {
        const { slotReleased } = await performCampaignVapiCleanup(supabaseAdmin, {
          vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
          campaignName,
          vapiAssistantId: capturedAssistantId,
          vapiPoolSlotId: capturedSlotId,
        });
        if (slotReleased) resultLabel = "paused_outside_window:slot_released";
      }
      resumeResults.push({ id: campaignId, name: campaignName, result: resultLabel });
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

  // ── Queue gate: pool-aware concurrency limit ──
  // Phase 1 of the dashboard rebuild (design doc §9.1) lifted the original
  // any-running-defers gate to a pool-aware limit. The SIP pool itself becomes
  // the rate-limiter: we count vapi_sip_pool rows with status='leased' and
  // defer if at or above CAMPAIGN_CONCURRENCY_LIMIT (default 3).
  //
  // Phased rollout per design doc §5.8:
  //   Phase 1: limit=3  — after originate-shim 5-concurrent load test passes
  //   Phase 2: limit=5  — after ~2 weeks of clean Phase 1 ops
  //
  // Per-campaign concurrency stays at 1 (sequential dialing within a campaign
  // keeps retry/chain-next state clean). The lift is at the scheduler level only.
  //
  // Note: this gate fires AFTER the resume sweep above so already-running
  // campaigns can still advance their retries on this tick.
  const limit = parseInt(process.env.CAMPAIGN_CONCURRENCY_LIMIT ?? "3", 10);
  const { count: leasedCount } = await supabaseAdmin
    .from("vapi_sip_pool")
    .select("id", { count: "exact", head: true })
    .eq("status", "leased");

  if ((leasedCount ?? 0) >= limit) {
    return NextResponse.json({
      started: 0,
      queued: true,
      reason: `pool at concurrency limit (${leasedCount}/${limit} leased) — deferring to next tick`,
      leasedCount: leasedCount ?? 0,
      concurrencyLimit: limit,
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
    .limit(1); // one new start per minute — gentle ramp to the concurrency limit

  if (error) {
    console.error("[campaign-scheduler] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // No early return on empty drafts: the recurring-spawn branch added below
  // needs to execute on every tick regardless of draft state. The for-loop
  // below is a no-op when campaigns is empty/null.
  const results: Array<{ id: string; name: string; result: string }> = [];

  for (const campaign of campaigns ?? []) {
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

    // ── Recurring parent campaign guard ──
    // If it's a recurring parent campaign, it doesn't dial directly. Just leave it running
    // so it can spawn child campaigns during scheduler ticks.
    if ((campaign.campaign_type as string) === "recurring") {
      results.push({ id: campaignId, name: campaignName, result: "started" });
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

  // ── Recurring child-spawn branch ──
  // For each campaign_type='recurring' parent with status='running', check
  // whether today's spawn time has arrived and a child hasn't yet been spawned.
  // The leased budget is refreshed per iteration so we don't over-spawn within
  // a single tick (draft→running above may have just leased one).
  //
  // Children are inserted as status='draft' with start_at=today's window open
  // in the parent's timezone. The existing draft→running flow above picks them
  // up at window-open time on a later tick. This avoids the resume-sweep
  // auto-pause collision that would happen if children were created 'running'
  // before their window.
  const recurringResults: Array<{ parentId: string; parentName: string } & SpawnOutcome> = [];
  const { data: recurringParents, error: recurringErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select(
      "id, name, timezone, recurrence_pattern, segment_id, base_assistant_id, voice_id, system_prompt, sms_enabled, sms_template, sms_on_goal_reached_only, is_test",
    )
    .eq("campaign_type", "recurring")
    .eq("status", "running");

  if (recurringErr) {
    console.error("[campaign-scheduler] recurring parents query failed:", recurringErr);
  } else {
    console.log(`[campaign-scheduler] recurring parents found: ${recurringParents?.length ?? 0}`);
  }

  if (recurringParents && recurringParents.length > 0) {
    const vapiKey = process.env.VAPI_PRIVATE_KEY;
    if (!vapiKey) {
      console.error("[campaign-scheduler] VAPI_PRIVATE_KEY missing; skipping recurring branch");
    } else {
      for (const parent of recurringParents) {
        // Refresh leased count per-iteration so we don't over-spawn this tick.
        const { count: nowLeased } = await supabaseAdmin
          .from("vapi_sip_pool")
          .select("id", { count: "exact", head: true })
          .eq("status", "leased");
        const budget = limit - (nowLeased ?? 0);
        if (budget <= 0) {
          recurringResults.push({
            parentId: parent.id as string,
            parentName: parent.name as string,
            result: "budget_full",
          });
          break;
        }
        const outcome = await spawnChildIfDue(
          supabaseAdmin,
          vapiKey,
          parent as unknown as RecurringParent,
          new Date(),
          budget,
        );
        recurringResults.push({
          parentId: parent.id as string,
          parentName: parent.name as string,
          ...outcome,
        });
      }
    }
  }

  return NextResponse.json({
    started: results.filter((r) => r.result === "started").length,
    results,
    resumed: resumeResults.filter((r) => r.result === "resumed").length,
    resumeResults,
    sweepResolved: sweeperResults.length,
    sweeperResults,
    spawned: recurringResults.filter((r) => r.result === "spawned").length,
    recurringResults,
  });
}
