import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";
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
  // Pull retry_interval_minutes too — used to size the imminent-retry window
  // per campaign so heartbeat doesn't false-flag during the early portion of
  // a 90-min wait (or longer if operator configured a different interval).
  const { data: running, error: runningErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, updated_at, retry_interval_minutes")
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

    // Pending-retry awareness (compliance / noise-reduction):
    // A campaign whose remaining work is all pending_retry awaiting their next
    // attempt would be flagged "stuck" by the previous heuristic — but it's
    // actually HEALTHY (just waiting). Lookahead window MUST be at least the
    // campaign's retry_interval_minutes; otherwise we false-flag the early
    // portion of a 90-min wait (heartbeat fires every 30min, retry interval
    // is 90min — without sizing the lookahead by retry_interval, the first
    // 60min of every wait would alarm).
    // Type-guard against schema corruption: the column is INT NOT NULL DEFAULT 90,
    // but defensive programming for null / NaN / string-typed values means we
    // guarantee a numeric value before Math.max. Otherwise `Math.max(NaN, 60)`
    // returns NaN → `new Date(NaN)` → `.toISOString()` throws → entire
    // heartbeat tick crashes for ALL campaigns.
    const retryRaw = c.retry_interval_minutes;
    const retryInterval =
      typeof retryRaw === "number" && Number.isFinite(retryRaw) && retryRaw > 0
        ? retryRaw
        : 90;
    const lookaheadMin = Math.max(retryInterval, 60);
    const lookaheadAt = new Date(Date.now() + lookaheadMin * 60 * 1000).toISOString();
    const { count: imminentRetryCount, error: retryErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", campaignId)
      .eq("outcome", "pending_retry")
      .lte("next_attempt_at", lookaheadAt);

    if (retryErr) {
      console.error(`[campaign-heartbeat] retry-count error for ${campaignId}:`, retryErr);
      // Fail-open: if we can't tell, assume healthy (better than false alarm)
      continue;
    }

    if (imminentRetryCount && imminentRetryCount > 0) {
      // Healthy: a retry will fire within the lookahead window; not stuck
      continue;
    }

    // Stuck: running, has pending work, no recent activity, no imminent retries
    stuck.push({
      id: campaignId,
      name: campaignName,
      lastUpdated: c.updated_at as string,
      pendingNumbers: pendingCount,
    });

    console.warn(
      `[campaign-heartbeat] STUCK: ${campaignName} (${campaignId}) — ` +
      `running with ${pendingCount} pending numbers, no calls in last ${STALE_WINDOW_MIN}m, ` +
      `no imminent retries. Operator action needed (pause + investigate, or resume manually).`,
    );
  }

  // ──────────────────────────────────────────────────────────────────────
  // SIP Pool reconciliation (Phase 2)
  // ──────────────────────────────────────────────────────────────────────
  // Four rules, gated by env so a missing key never crashes the heartbeat:
  //   Rule 1: AUTO-RELEASE — leased slot with no campaign_id, >5min old
  //           (createCampaignV2 never completed after clone-assistant leased)
  //   Rule 2: AUTO-RELEASE — leased slot with campaign in terminal state >10min
  //           (DELETE bypassed or campaign auto-completed without DELETE)
  //   Rule 3: DETECT ONLY — assistantId on Vapi disagrees with DB; log loudly,
  //           manual intervention required (cause is ambiguous)
  //   Rule 4: AUTO-RECOVER — slot in maintenance >6h (eject's PATCH-detach
  //           failed earlier; retry via reconcileRelease which already does
  //           PATCH retry + DELETE assistant + free-or-maintenance fallback.
  //           Added 2026-05-22 after the May 21 Cloudflare 522/504 incident.)
  //
  // Decisions LOCKED 2026-05-15 by Jas: Option C hybrid (auto for 1+2, detect
  // for 3) and best-effort Vapi assistant DELETE on Rule 1/2 firings.
  // Rule 4 locked with Jas 2026-05-22.
  const poolReconciliation: {
    rule1Released: Array<{ slotIndex: number; assistantId: string | null; leasedAt: string }>;
    rule2Released: Array<{ slotIndex: number; campaignId: string; campaignStatus: string }>;
    rule3Drift: Array<{ slotIndex: number; dbAssistantId: string | null; vapiAssistantId: string | null }>;
    rule4Recovered: Array<{ slotIndex: number; assistantId: string | null; leasedAt: string }>;
    rule4StillStuck: Array<{ slotIndex: number; assistantId: string | null; leasedAt: string }>;
    warnings: string[];
  } = { rule1Released: [], rule2Released: [], rule3Drift: [], rule4Recovered: [], rule4StillStuck: [], warnings: [] };

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    poolReconciliation.warnings.push("VAPI_PRIVATE_KEY not set — pool reconciliation skipped");
    console.warn("[campaign-heartbeat] VAPI_PRIVATE_KEY not set — pool reconciliation skipped");
  } else {
    const { data: leasedSlots, error: poolErr } = await supabaseAdmin
      .from("vapi_sip_pool")
      .select("id, slot_index, vapi_phone_number_id, current_assistant_id, current_campaign_id, leased_at")
      .eq("status", "leased")
      .order("slot_index");

    if (poolErr) {
      console.error("[campaign-heartbeat] pool query error:", poolErr);
      poolReconciliation.warnings.push(`pool query error: ${poolErr.message}`);
    } else if (leasedSlots && leasedSlots.length > 0) {
      const RULE1_CUTOFF = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const RULE2_CUTOFF = new Date(Date.now() - 10 * 60 * 1000).toISOString();
      const TERMINAL_STATUSES = ["completed", "failed", "archived"];

      for (const slot of leasedSlots) {
        const slotLabel = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;

        // ── Rule 1: orphan lease (no campaign linked, leased > 5min) ──
        if (!slot.current_campaign_id) {
          if (!slot.leased_at || slot.leased_at >= RULE1_CUTOFF) continue;
          console.warn(
            `[campaign-heartbeat] RULE 1 — orphan lease on ${slotLabel}: ` +
            `assistant=${slot.current_assistant_id ?? "null"} leased_at=${slot.leased_at} — releasing`,
          );
          const released = await reconcileRelease(
            slot.id,
            slot.slot_index,
            slot.vapi_phone_number_id,
            slot.current_assistant_id,
            vapiKey,
            poolReconciliation.warnings,
          );
          if (released) {
            poolReconciliation.rule1Released.push({
              slotIndex: slot.slot_index,
              assistantId: slot.current_assistant_id,
              leasedAt: slot.leased_at,
            });
          }
          continue; // released — skip Rule 3 for this slot
        }

        // ── Rule 2: campaign in terminal state >10min (or missing) ──
        const { data: campaign, error: campErr } = await supabaseAdmin
          .from("campaigns_v2")
          .select("id, status, updated_at")
          .eq("id", slot.current_campaign_id)
          .maybeSingle();
        if (campErr) {
          console.error(`[campaign-heartbeat] campaign lookup error for slot ${slotLabel}:`, campErr);
          poolReconciliation.warnings.push(`campaign lookup failed for ${slotLabel}: ${campErr.message}`);
          continue;
        }
        const campaignMissing = !campaign;
        const campaignTerminal =
          campaign &&
          TERMINAL_STATUSES.includes(campaign.status) &&
          campaign.updated_at &&
          campaign.updated_at < RULE2_CUTOFF;
        if (campaignMissing || campaignTerminal) {
          const reason = campaignMissing
            ? `campaign ${slot.current_campaign_id} no longer exists`
            : `campaign ${campaign!.id} status=${campaign!.status} since ${campaign!.updated_at}`;
          console.warn(
            `[campaign-heartbeat] RULE 2 — terminal-state lease on ${slotLabel}: ${reason} — releasing`,
          );
          const released = await reconcileRelease(
            slot.id,
            slot.slot_index,
            slot.vapi_phone_number_id,
            slot.current_assistant_id,
            vapiKey,
            poolReconciliation.warnings,
          );
          if (released) {
            poolReconciliation.rule2Released.push({
              slotIndex: slot.slot_index,
              campaignId: slot.current_campaign_id,
              campaignStatus: campaign?.status ?? "missing",
            });
          }
          continue;
        }

        // ── Rule 3: detect-only Vapi vs DB drift ──
        try {
          const res = await fetch(
            `https://api.vapi.ai/phone-number/${encodeURIComponent(slot.vapi_phone_number_id)}`,
            { headers: { Authorization: `Bearer ${vapiKey}`, Accept: "application/json" } },
          );
          if (!res.ok) {
            poolReconciliation.warnings.push(`Rule 3 GET ${slotLabel} HTTP ${res.status}`);
            continue;
          }
          const phone = (await res.json()) as { assistantId?: string | null };
          const vapiAssistantId = phone.assistantId ?? null;
          if (vapiAssistantId !== slot.current_assistant_id) {
            console.warn(
              `[campaign-heartbeat] RULE 3 — DRIFT on ${slotLabel}: ` +
              `db=${slot.current_assistant_id ?? "null"} vapi=${vapiAssistantId ?? "null"} — ` +
              `manual intervention required`,
            );
            poolReconciliation.rule3Drift.push({
              slotIndex: slot.slot_index,
              dbAssistantId: slot.current_assistant_id,
              vapiAssistantId,
            });
          }
        } catch (err) {
          poolReconciliation.warnings.push(`Rule 3 fetch error ${slotLabel}: ${(err as Error).message}`);
        }
      }
    }

    // ── Rule 4: maintenance-trapped slot recovery >6h old ──
    // Separate SELECT because the leased-slot loop above only operates on
    // status='leased'. When eject's PATCH-detach failed earlier (Vapi 5xx /
    // Cloudflare 522/504), the slot was parked here. reconcileRelease re-runs
    // the same sequence and either lands the slot in 'free' (Vapi recovered)
    // or refreshes the maintenance notes (Vapi still failing — try again
    // next heartbeat). 6h threshold avoids storming Vapi during incidents.
    const RULE4_CUTOFF = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
    const { data: maintenanceSlots, error: maintErr } = await supabaseAdmin
      .from("vapi_sip_pool")
      .select("id, slot_index, vapi_phone_number_id, current_assistant_id, current_campaign_id, leased_at")
      .eq("status", "maintenance")
      .lt("leased_at", RULE4_CUTOFF)
      .order("slot_index");

    if (maintErr) {
      console.error("[campaign-heartbeat] Rule 4 query error:", maintErr);
      poolReconciliation.warnings.push(`Rule 4 query error: ${maintErr.message}`);
    } else if (maintenanceSlots && maintenanceSlots.length > 0) {
      for (const slot of maintenanceSlots) {
        const slotLabel = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;
        console.warn(
          `[campaign-heartbeat] RULE 4 — retrying maintenance ${slotLabel}: ` +
          `assistant=${slot.current_assistant_id ?? "null"} leased_at=${slot.leased_at}`,
        );
        const released = await reconcileRelease(
          slot.id,
          slot.slot_index,
          slot.vapi_phone_number_id,
          slot.current_assistant_id,
          vapiKey,
          poolReconciliation.warnings,
        );
        const record = {
          slotIndex: slot.slot_index,
          assistantId: slot.current_assistant_id,
          leasedAt: slot.leased_at,
        };
        if (released) {
          poolReconciliation.rule4Recovered.push(record);
        } else {
          poolReconciliation.rule4StillStuck.push(record);
        }
      }
    }
  }

  return NextResponse.json({
    checked: running.length,
    stuck,
    staleWindowMinutes: STALE_WINDOW_MIN,
    poolReconciliation,
  });
}

/**
 * Best-effort reconciliation: detach the phone number, delete the orphaned
 * clone, release the slot. Returns true if the slot reached `free` state.
 * On PATCH failure: marks slot `maintenance` instead of `free` so it won't
 * auto-lease until operator clears (matches campaigns-v2 DELETE handler).
 * Errors are pushed to the `warnings` array; never throws.
 */
async function reconcileRelease(
  slotId: string,
  slotIndex: number,
  vapiPhoneNumberId: string,
  assistantId: string | null,
  vapiKey: string,
  warnings: string[],
): Promise<boolean> {
  const slotLabel = `voizo-sip-pool-slot-${String(slotIndex).padStart(2, "0")}`;

  // 1. PATCH phone-number → null (detach before any DELETE).
  const patch = await patchPhoneAssistant(vapiKey, vapiPhoneNumberId, null).catch((err: Error) => ({
    ok: false,
    status: 0,
    body: err.message,
  }));
  if (!patch.ok) {
    warnings.push(`${slotLabel} detach failed (${patch.status}) — marking maintenance`);
    console.error(`[campaign-heartbeat] ${slotLabel} detach failed (${patch.status}): ${patch.body.slice(0, 200)}`);
    await supabaseAdmin
      .from("vapi_sip_pool")
      .update({
        status: "maintenance",
        notes: `heartbeat detach failed @ ${new Date().toISOString()}: ${patch.body.slice(0, 200)}`,
      })
      .eq("id", slotId);
    return false;
  }

  // 2. Best-effort DELETE of the orphaned clone assistant (404 = already gone).
  if (assistantId) {
    try {
      const delRes = await fetch(`https://api.vapi.ai/assistant/${encodeURIComponent(assistantId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${vapiKey}` },
      });
      if (!delRes.ok && delRes.status !== 404) {
        warnings.push(`${slotLabel} assistant delete returned ${delRes.status}`);
        console.warn(`[campaign-heartbeat] ${slotLabel} assistant ${assistantId} delete HTTP ${delRes.status}`);
      }
    } catch (err) {
      warnings.push(`${slotLabel} assistant delete error: ${(err as Error).message}`);
    }
  }

  // 3. Release slot to free.
  const released = await releaseSlot(supabaseAdmin, slotId).catch((err: Error) => {
    warnings.push(`${slotLabel} releaseSlot failed: ${err.message}`);
    return false;
  });
  if (released) {
    console.warn(`[campaign-heartbeat] ${slotLabel} RELEASED to free`);
  }
  return released;
}
