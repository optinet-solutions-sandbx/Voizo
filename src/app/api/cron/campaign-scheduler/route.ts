import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, hasPendingRetry, isWithinCallWindow } from "@/lib/dialer";
import { spawnChildIfDue, type RecurringParent, type SpawnOutcome } from "@/lib/scheduler/recurringSpawn";
import { recurringBudgetExhausted } from "@/lib/scheduler/spawnBudget";
import { orderDraftsProdFirst } from "@/lib/scheduler/draftPriority";
import { decideStuckResolution } from "@/lib/scheduler/stuckSweep";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { pauseReleasesSlot } from "@/lib/featureFlags";
import { CRON_NAMES, recordHeartbeat, postSlackNote, postSlackAlert, shouldAlertSpawnFail } from "@/lib/alerts/slack";
import crypto from "crypto";

// FS bgapi originate takes 8-22s per call. With 60s budget and limit(2),
// we can safely start 2 campaigns per cron tick. Remaining campaigns are
// picked up on the next tick (1 minute later).
export const maxDuration = 60;

// Resume-sweep wall-clock budget. The fairness fix serves ALL idle running
// campaigns each tick (not just the oldest), so we cap the expensive dials: stop
// firing resumes once fewer than (BUDGET + SAFETY) ms of the maxDuration tick
// remain, leaving room for the draft-start fire + recurring branch below. Each
// fireCall is 8-22s (FS originate); over-budget campaigns resume on the next tick.
const RESUME_FIRE_BUDGET_MS = 25_000;
const RESUME_SAFETY_MS = 5_000;

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
  // F11: stamp tick start so the recurring branch can defer a spawn it can't
  // safely finish within maxDuration (a hard-timeout mid-spawn orphans a
  // billable clone + a leased SIP slot). See lib/scheduler/spawnBudget.ts.
  const tickStartedAt = Date.now();

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
  // Status-aware (P2 fix, 2026-06-17): the candidate scan covers ALL in_progress
  // rows, but resolution depends on the owning campaign's status — see
  // lib/scheduler/stuckSweep.ts. running/paused resolve normally (paused dials on
  // resume, restoring Maria's retry); completed/inactive/etc. resolve to terminal
  // `unreached`. Previously the gate skipped every non-running campaign, stranding
  // their in_progress numbers forever.
  //
  // Bounded:
  //   - .limit(50) on the candidate query
  //   - .eq("outcome", "in_progress") guard on every UPDATE prevents stomping
  //     late-arriving Vapi outcomes (sent_sms / not_interested / declined_offer)
  //   - MIN_GRACE_SEC floor on next_attempt_at prevents tight-loop thrash
  //     when retry_interval_minutes is set to a small value for testing
  const STALE_GRACE_MS = 5 * 60 * 1000;
  const MIN_GRACE_SEC = 60; // floor on next_attempt_at offset (defense vs retry_interval=0 testing)
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
    if (!campaign) continue; // can't classify without the campaign row

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

    // Status-aware decision (pure — see lib/scheduler/stuckSweep.ts). Resumable
    // campaigns (running/paused) resolve normally; terminal ones (completed/
    // inactive/etc.) resolve to `unreached` instead of being skipped forever.
    const action = decideStuckResolution({
      campaignStatus: campaign.status,
      latestCall: latestCall
        ? { status: latestCall.status as string, ended_at: (latestCall.ended_at as string | null) ?? null }
        : null,
      attemptCount: (n.attempt_count as number) ?? 0,
      maxAttempts: campaign.max_attempts,
      sweepCutoffIso: sweepCutoff,
    });

    // skip: latest call still live, or ended within the grace window — wait for the
    // chain-next / end-of-call webhook to set the real outcome (same in_progress guard).
    if (action === "skip") continue;

    if (action === "pending") {
      // No calls_v2 row: fireCall failed pre-INSERT, no dial happened. Revert to
      // pending (no attempt_count bump) so the next tick re-attempts cleanly.
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "pending", next_attempt_at: null })
        .eq("id", numberId)
        .eq("outcome", "in_progress");
      console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → pending (no calls_v2 row — fireCall failed pre-INSERT)`);
      sweeperResults.push({ id: numberId, result: "reverted_to_pending" });
      continue;
    }

    if (action === "pending_retry") {
      // Floor next_attempt_at at now + MIN_GRACE_SEC so a same-tick resume sweep
      // can't fire a fresh retry that races a still-in-flight late Vapi webhook.
      // On a paused campaign this just waits for resume (no dial while paused).
      const retryMs = Math.max(campaign.retry_interval_minutes * 60 * 1000, MIN_GRACE_SEC * 1000);
      const retryAt = new Date(Date.now() + retryMs).toISOString();
      await supabaseAdmin
        .from("campaign_numbers_v2")
        .update({ outcome: "pending_retry", next_attempt_at: retryAt })
        .eq("id", numberId)
        .eq("outcome", "in_progress");
      console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → pending_retry @ ${retryAt}`);
      sweeperResults.push({ id: numberId, result: "pending_retry" });
      continue;
    }

    // unreached_max (resumable, at max attempts) | unreached_terminal (campaign will
    // never dial again). Both write the terminal `unreached`; the stomp-guard still
    // yields to a late real outcome that arrives before this UPDATE.
    await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "unreached" })
      .eq("id", numberId)
      .eq("outcome", "in_progress");
    const why = action === "unreached_max" ? "max attempts" : `terminal campaign — status=${campaign.status}`;
    console.log(`[scheduler.sweep] ${campaign.name}: ${numberId} → unreached (${why})`);
    sweeperResults.push({
      id: numberId,
      result: action === "unreached_max" ? "unreached_exhausted" : "unreached_terminal_campaign",
    });
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
  //   - FAIRNESS: serves ALL idle running campaigns each tick. Was limit(1)
  //     ordered oldest-updated_at, which let an older parked campaign monopolize
  //     the single backstop slot and STARVE newer ones (their pending numbers never
  //     dialed when chain-next had broken). Now bounded by a wall-clock budget guard
  //     (RESUME_FIRE_BUDGET_MS) so a busy tick still can't burn the 60s function
  //     budget on multiple 8-22s fireCalls; over-budget campaigns resume next tick.
  const { data: idleRunning, error: idleRunningErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("status", "running")
    .neq("campaign_type", "recurring") // Recurring parents have no campaign_numbers_v2 rows by
                                       // design — they're schedule definitions, not dial lists.
                                       // Without this filter the self-heal at line 240 would
                                       // flip them to 'completed' on the next tick.
    // ROTATION (fairness under budget pressure): least-recently-SWEPT first.
    // last_swept_at is a write-before-fire rotation STAMP (see the stamp below):
    // success, fire_failed, and even a mid-fire maxDuration kill all rotate the
    // campaign to the back. It is NOT a lock/lease — no mutual exclusion; tick-
    // overlap dedupe rests solely on the in-flight check below. NULLS FIRST puts
    // never-swept campaigns at the front; updated_at asc is the stable tiebreak
    // (the pre-rotation ordering). Deliberately NOT last_resumed_at — that column
    // is the OPERATOR resume/rebind record (rebindCore.ts, pairs with
    // last_paused_at for pause telemetry); a per-minute sweep stamp would
    // overwrite it. This rotation is the prerequisite for raising
    // CAMPAIGN_CONCURRENCY_LIMIT 3 → 5: without it, campaigns ranked 4th+ starved
    // under sustained budget pressure, and a campaign whose fireCall always
    // failed pinned the front of the queue every tick.
    .order("last_swept_at", { ascending: true, nullsFirst: true })
    .order("updated_at", { ascending: true })
    .limit(20); // FAIRNESS FIX: serve ALL idle running campaigns each tick (was
                // limit(1), which starved newer campaigns when an older one hogged
                // the single backstop slot). 20 >> the pool concurrency limit; the
                // wall-clock guard before each fire bounds total dial cost.

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
      //
      // When PAUSE_RELEASES_SLOT is on, also clear Vapi pointers + release
      // the SIP slot via the shared cleanup helper. The flag controls BOTH
      // pause and complete eject by design — single operator knob, shared
      // semantics with the outside-window pause block above. Without this,
      // 5 consecutive auto-completions exhaust the SIP pool with Manual
      // Eject as the only recovery.
      if (!(await hasPendingRetry(campaignId))) {
        const releaseOnComplete = pauseReleasesSlot();
        const capturedAssistantId = campaign.vapi_assistant_id as string | null;
        const capturedSlotId = campaign.vapi_pool_slot_id as string | null;

        const completePayload: Record<string, unknown> = { status: "completed" };
        if (releaseOnComplete) {
          completePayload.vapi_assistant_id = null;
          completePayload.vapi_pool_slot_id = null;
          completePayload.vapi_sip_uri = null;
        }

        const { data: completedUpdate } = await supabaseAdmin
          .from("campaigns_v2")
          .update(completePayload)
          .eq("id", campaignId)
          .eq("status", "running")
          .select("id")
          .single();

        let resultLabel = "auto_completed";
        if (completedUpdate && releaseOnComplete) {
          const { slotReleased, vapiWarnings } = await performCampaignVapiCleanup(supabaseAdmin, {
            vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
            campaignName,
            vapiAssistantId: capturedAssistantId,
            vapiPoolSlotId: capturedSlotId,
          });
          if (slotReleased) resultLabel = "auto_completed:slot_released";
          if (vapiWarnings.length > 0) {
            console.warn(`[scheduler.resume.complete] ${campaignName}: cleanup warnings: ${vapiWarnings.join(" | ")}`);
          }
        }
        resumeResults.push({ id: campaignId, name: campaignName, result: resultLabel });
      }
      continue;
    }

    // Budget guard (pairs with the serve-all fairness fix above): stop firing
    // resumes once too little wall-clock remains, so a tick that needs to advance
    // several stalled campaigns can't blow maxDuration. Deferral happens BEFORE
    // the rotation stamp, so deferred campaigns keep their front (least-recently-
    // swept) rank next tick — none starves.
    if (Date.now() - tickStartedAt > maxDuration * 1000 - RESUME_FIRE_BUDGET_MS - RESUME_SAFETY_MS) {
      resumeResults.push({ id: campaignId, name: campaignName, result: "deferred_low_budget" });
      break;
    }

    // Rotation stamp, written BEFORE firing: this campaign is about to consume
    // dial budget, so send it to the back of the rotation regardless of how the
    // fire ends — success, throw, or a mid-fire maxDuration kill. Stamping after
    // would let a reliably-hanging/failing fireCall pin the front slot every tick.
    // NOT a lock/lease: an overlapping tick is only deduped by the in-flight
    // check above. The status='running' guard keeps the set_updated_at trigger
    // off concurrently-terminal rows (it would defer heartbeat Rule-2's slot
    // release) — and a 0-row match means the campaign left `running` since the
    // tick-start select, so we must NOT dial for it (freshness re-check).
    // A transient stamp ERROR is logged but never blocks a due dial (matches the
    // pre-rotation code, which had no stamp at all). Cheap skips above
    // (in-flight / window-pause / auto-complete / nothing-due) do NOT rotate —
    // they consume no dial budget.
    const { data: stamped, error: rotateErr } = await supabaseAdmin
      .from("campaigns_v2")
      .update({ last_swept_at: new Date().toISOString() })
      .eq("id", campaignId)
      .eq("status", "running")
      .select("id");
    if (rotateErr) {
      console.warn(`[scheduler.resume] ${campaignName}: last_swept_at stamp failed (continuing):`, rotateErr.message);
    } else if (!stamped || stamped.length === 0) {
      resumeResults.push({ id: campaignId, name: campaignName, result: "skipped_no_longer_running" });
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
  // H1 (audit 2026-06-01): destructure `error` so a transient Supabase blip
  // can't silently set leasedCount=undefined → (undefined ?? 0) >= limit = false
  // → cron bypasses the pool-aware concurrency gate. Fail-closed: on count error,
  // defer this tick (200 not 500) and let the next minute retry.
  const { count: leasedCount, error: poolCountErr } = await supabaseAdmin
    .from("vapi_sip_pool")
    .select("id", { count: "exact", head: true })
    .eq("status", "leased");

  if (poolCountErr) {
    console.error("[campaign-scheduler] pool count query failed — deferring tick:", poolCountErr);
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.scheduler);
    return NextResponse.json({
      started: 0,
      queued: true,
      reason: `pool count query failed: ${poolCountErr.message}`,
      resumed: resumeResults.filter((r) => r.result === "resumed").length,
      resumeResults,
      sweepResolved: sweeperResults.length,
      sweeperResults,
    });
  }

  if ((leasedCount ?? 0) >= limit) {
    await recordHeartbeat(supabaseAdmin, CRON_NAMES.scheduler);
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

  const { data: readyDrafts, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("status", "draft")
    .not("start_at", "is", null)
    .lte("start_at", now)
    .order("start_at", { ascending: true }) // FIFO baseline
    .limit(10); // fetch a few ready drafts; the prod-priority pick below still starts ONE

  if (error) {
    console.error("[campaign-scheduler] query error:", error);
    return NextResponse.json({ error: "DB error" }, { status: 500 });
  }

  // Production drafts auto-start before internal GhostPortal drafts: a ghost run
  // can never jump the queue for this tick's single start slot. Ghost's primary
  // headroom guard is still leaseSlotForGhost's reserve floor at launch time.
  // Still exactly one new start per minute — gentle ramp to the concurrency limit.
  const campaigns = orderDraftsProdFirst(readyDrafts ?? []).slice(0, 1);

  // No early return on empty drafts: the recurring-spawn branch added below
  // needs to execute on every tick regardless of draft state. The for-loop
  // below is a no-op when campaigns is empty.
  const results: Array<{ id: string; name: string; result: string }> = [];

  for (const campaign of campaigns) {
    const campaignId = campaign.id as string;
    const campaignName = campaign.name as string;

    // ── Call window check ──
    const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
    const timezone = campaign.timezone as string;
    if (callWindows && callWindows.length > 0 && !isWithinCallWindow(callWindows, timezone)) {
      console.log(`[campaign-scheduler] ${campaignName}: inside start_at window but outside call window — skipping`);
      // Surface the silent defer to operators. This branch fires on EVERY ~60s
      // tick for a campaign stuck outside its window (e.g. a day/window mismatch
      // or a classic-created campaign that bypassed the creation guards), so it
      // is the real backstop for a "scheduled but never dials" campaign. Dedup
      // via scheduler_alert_state (mirrors the recurring spawn_failed dedup) so
      // a stuck campaign posts at most once per ~6h, not ~1,440x/day.
      const winCompact = callWindows.map((w) => `${w.day} ${w.start}-${w.end}`).join("|");
      const reason =
        `due (start_at has passed) but the current time is outside the call window — deferring. ` +
        `tz=${timezone}, windows=[${winCompact}]. Will not dial until the window opens; ` +
        `if it never does, check for a day-of-window mismatch.`;
      const { data: alertRow } = await supabaseAdmin
        .from("scheduler_alert_state")
        .select("last_alerted_at")
        .eq("campaign_id", campaignId)
        .maybeSingle();
      // shouldAlertSpawnFail is the generic time-window dedup predicate (default 6h).
      if (shouldAlertSpawnFail((alertRow?.last_alerted_at as string | null) ?? null, Date.now())) {
        await postSlackAlert("WARN", "Campaign outside call window", [`${campaignName}: ${reason}`]);
        await supabaseAdmin.from("scheduler_alert_state").upsert(
          { campaign_id: campaignId, reason, last_alerted_at: new Date().toISOString() },
          { onConflict: "campaign_id" },
        );
      }
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

    // Campaign just transitioned draft → running, so clear any outside-window
    // alert state — a future re-defer (e.g. after a schedule edit) should be
    // allowed to alert again. No-op when no row exists. Mirrors the recurring
    // recovery-clear (recurring_alert_state delete on a successful spawn).
    await supabaseAdmin.from("scheduler_alert_state").delete().eq("campaign_id", campaignId);

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
      // Genuinely empty draft → completed. Mirror the resume-sweep auto-complete:
      // when PAUSE_RELEASES_SLOT is on, also release the SIP slot so the pool
      // count tracks actual occupancy. Same flag covers pause + complete.
      const releaseOnComplete = pauseReleasesSlot();
      const capturedAssistantId = campaign.vapi_assistant_id as string | null;
      const capturedSlotId = campaign.vapi_pool_slot_id as string | null;

      const completePayload: Record<string, unknown> = { status: "completed" };
      if (releaseOnComplete) {
        completePayload.vapi_assistant_id = null;
        completePayload.vapi_pool_slot_id = null;
        completePayload.vapi_sip_uri = null;
      }

      const { data: completedUpdate } = await supabaseAdmin
        .from("campaigns_v2")
        .update(completePayload)
        .eq("id", campaignId)
        .eq("status", "running")
        .select("id")
        .single();

      let resultLabel = "no_eligible_numbers";
      if (completedUpdate && releaseOnComplete) {
        const { slotReleased, vapiWarnings } = await performCampaignVapiCleanup(supabaseAdmin, {
          vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
          campaignName,
          vapiAssistantId: capturedAssistantId,
          vapiPoolSlotId: capturedSlotId,
        });
        if (slotReleased) resultLabel = "no_eligible_numbers:slot_released";
        if (vapiWarnings.length > 0) {
          console.warn(`[scheduler.start.complete] ${campaignName}: cleanup warnings: ${vapiWarnings.join(" | ")}`);
        }
      }
      results.push({ id: campaignId, name: campaignName, result: resultLabel });
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
  const recurringResults: Array<
    { parentId: string; parentName: string } & (SpawnOutcome | { result: "deferred_low_budget" })
  > = [];
  const { data: recurringParents, error: recurringErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select(
      "id, name, timezone, recurrence_pattern, segment_id, base_assistant_id, voice_id, system_prompt, sms_enabled, sms_template, sms_on_goal_reached_only, sms_consent_mode, is_test",
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
        // F11: never START a spawn we can't finish this tick. A hard maxDuration
        // kill between leaseSlot and the final INSERT/linkSlot would orphan a
        // billable clone + a leased slot. Defer the rest to the next tick (60s).
        if (recurringBudgetExhausted(Date.now() - tickStartedAt, maxDuration)) {
          recurringResults.push({
            parentId: parent.id as string,
            parentName: parent.name as string,
            result: "deferred_low_budget",
          });
          break;
        }
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

        // A: narrate this spawn to Slack (#voizo-alerts). `spawned` and
        // `segment_empty_skipped` fire at most once per parent per day (the
        // per-day idempotency check makes later ticks return already_spawned_today),
        // so no throttle is needed. `spawn_failed` IS deduped via
        // recurring_alert_state (a misconfigured parent fails every tick), so a
        // broken parent posts at most once per ~6h. Transient outcomes
        // (deferred_low_budget / budget_full / off_week / already_spawned_today /
        // not_due) are intentionally NOT posted — they would be per-tick noise.
        const parentTz = parent.timezone as string;
        if (outcome.result === "spawned") {
          await postSlackNote("Recurring spawn", [
            `${parent.name as string}: segment refreshed -> dialing ${outcome.dialCount} player(s) today, ` +
              `${outcome.windowStart}-${outcome.windowEnd} ${parentTz}.`,
          ]);
          // A recovered parent should be able to alert again on a future failure.
          await supabaseAdmin.from("recurring_alert_state").delete().eq("parent_id", parent.id as string);
        } else if (outcome.result === "segment_empty_skipped") {
          await postSlackNote("Recurring spawn", [
            `${parent.name as string}: segment empty today -> skipped (no worker leased).`,
          ]);
        } else if (outcome.result === "spawn_failed") {
          const { data: alertRow } = await supabaseAdmin
            .from("recurring_alert_state")
            .select("last_alerted_at")
            .eq("parent_id", parent.id as string)
            .maybeSingle();
          if (shouldAlertSpawnFail((alertRow?.last_alerted_at as string | null) ?? null, Date.now())) {
            await postSlackAlert("WARN", "Recurring spawn failed", [
              `${parent.name as string}: ${outcome.details}`,
            ]);
            await supabaseAdmin.from("recurring_alert_state").upsert(
              {
                parent_id: parent.id as string,
                reason: outcome.details,
                last_alerted_at: new Date().toISOString(),
              },
              { onConflict: "parent_id" },
            );
          }
        }
      }
    }
  }

  await recordHeartbeat(supabaseAdmin, CRON_NAMES.scheduler);
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
