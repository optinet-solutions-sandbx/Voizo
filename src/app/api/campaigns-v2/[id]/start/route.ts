import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { findNextNumber, fireCall, hasPendingRetry, isWithinCallWindow } from "@/lib/dialer";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { pauseReleasesSlot } from "@/lib/featureFlags";

// FreeSWITCH bgapi originate callback fires 8-22s after the command is sent on
// this box (memory project_freeswitch_bgapi_slow). The originate-shim's own
// timeout is 30s. Default Vercel function timeout (10s on Hobby/Free, 15s on
// Pro) would 504 mid-bgapi. Bumping to 60s keeps both planes in sync.
export const maxDuration = 60;

/**
 * POST /api/campaigns-v2/[id]/start
 *
 * Starts (or resumes) a Campaign V2.
 *
 * Manifesto compliance:
 * - Call window checked before first dial
 * - Suppression checked inside findNextNumber
 * - Concurrency guard: only draft/paused → running transition allowed
 * - State written to DB before calling Twilio
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  // Fetch campaign
  const { data: campaign, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("id", id)
    .single();

  if (error || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (campaign.status !== "draft" && campaign.status !== "paused") {
    return NextResponse.json(
      { error: `Cannot start campaign with status "${campaign.status}"` },
      { status: 400 },
    );
  }

  // ── Schedule guard: respect start_at if set ──
  // If the operator scheduled this campaign for a future time, don't let a
  // manual Start override that. The auto-scheduler (cron) will fire it on time.
  const startAt = campaign.start_at ? new Date(campaign.start_at) : null;
  if (startAt && startAt.getTime() > Date.now()) {
    const formatted = startAt.toLocaleString("en-US", {
      timeZone: campaign.timezone || "UTC",
      dateStyle: "medium",
      timeStyle: "short",
    });
    return NextResponse.json(
      { error: `Campaign is scheduled for ${formatted}. It will start automatically at that time.` },
      { status: 400 },
    );
  }

  // ── Call window check (Manifesto §6: check before every dial) ──
  const callWindows = campaign.call_windows as Array<{ day: string; start: string; end: string }> | null;
  if (callWindows && callWindows.length > 0 && !isWithinCallWindow(callWindows, campaign.timezone)) {
    return NextResponse.json(
      { error: "Outside call window. Campaign cannot start dialing right now." },
      { status: 400 },
    );
  }

  // ── Queue gate: only one campaign runs at a time (MVP constraint) ──
  // Chris's directive 2026-05-07. Pairs with the same check in
  // /api/cron/campaign-scheduler — both gates prevent more than one
  // campaign reaching status='running' under normal operation.
  // Trade-off: count-then-update is not perfectly atomic; a sub-millisecond
  // race could let two campaigns through. The stuck-campaign heartbeat
  // (Phase 1) surfaces anomalies as a backstop.
  const { count: runningCount } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id", { count: "exact", head: true })
    .eq("status", "running")
    .neq("campaign_type", "recurring") // Exclude recurring parent campaigns so they don't block starting fixed campaigns
    .neq("id", id); // defensive: exclude self in any race scenario

  if (runningCount && runningCount > 0) {
    return NextResponse.json(
      {
        error: "Another campaign is currently running. Wait for it to complete, or pause it first.",
        queueLimit: 1,
      },
      { status: 409 },
    );
  }

  // ── Concurrency guard (H2): atomic status transition ──
  // Only update if status is still draft/paused (prevents double-click race)
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update({ status: "running" })
    .eq("id", id)
    .in("status", ["draft", "paused"])
    .select()
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      { error: "Campaign already running or completed (concurrent start detected)" },
      { status: 409 },
    );
  }

  // ── Recurring parent campaign guard ──
  // If it's a recurring parent campaign, it doesn't dial directly. Just leave it running
  // so it can spawn child campaigns during scheduler ticks.
  if ((campaign.campaign_type as string) === "recurring") {
    return NextResponse.json({
      message: "Recurring parent campaign started successfully.",
      status: "running",
    });
  }

  // Find next eligible number
  const nextNumber = await findNextNumber(id);
  if (!nextNumber) {
    // No number eligible RIGHT NOW. If pending_retry numbers exist with future
    // next_attempt_at, the campaign is idle-waiting for the retry window —
    // keep it `running` so the scheduler cron can advance it when a retry
    // comes due. Only mark `completed` when there's truly nothing left.
    if (await hasPendingRetry(id)) {
      return NextResponse.json({
        message: "Campaign resumed. Idle-waiting for next retry window.",
        waiting: true,
      });
    }
    // Operator hit Start on a campaign with no dialable work → completed.
    // Mirror the auto-eject pattern from the scheduler + chain-next webhook:
    // when PAUSE_RELEASES_SLOT is on, capture Vapi pointers and run the
    // shared cleanup helper. Same flag covers pause and complete eject.
    const releaseOnComplete = pauseReleasesSlot();
    const capturedAssistantId = campaign.vapi_assistant_id as string | null;
    const capturedSlotId = campaign.vapi_pool_slot_id as string | null;
    const campaignName = campaign.name as string;

    const completePayload: Record<string, unknown> = { status: "completed" };
    if (releaseOnComplete) {
      completePayload.vapi_assistant_id = null;
      completePayload.vapi_pool_slot_id = null;
      completePayload.vapi_sip_uri = null;
    }

    const { data: completedUpdate } = await supabaseAdmin
      .from("campaigns_v2")
      .update(completePayload)
      .eq("id", id)
      .eq("status", "running")
      .select("id")
      .single();

    if (completedUpdate && releaseOnComplete) {
      const { vapiWarnings } = await performCampaignVapiCleanup(supabaseAdmin, {
        vapiKey: process.env.VAPI_PRIVATE_KEY ?? "",
        campaignName,
        vapiAssistantId: capturedAssistantId,
        vapiPoolSlotId: capturedSlotId,
      });
      if (vapiWarnings.length > 0) {
        console.warn(`[campaigns-v2.start.complete] ${campaignName}: cleanup warnings: ${vapiWarnings.join(" | ")}`);
      }
    }
    return NextResponse.json({ message: "No eligible numbers to dial. Campaign completed." });
  }

  const baseUrl = getBaseUrl(request);

  try {
    const callRow = await fireCall(id, nextNumber, campaign.vapi_assistant_id, baseUrl, campaign.vapi_sip_uri ?? undefined);
    return NextResponse.json({
      message: "Campaign started. First call fired.",
      callId: callRow.id,
      phone: nextNumber.phone_e164,
    });
  } catch (err) {
    console.error("Failed to fire call:", err);
    // Match the chain-next webhook pattern: log + return without pausing.
    // With B2 (cron resume sweep) in place, pause-on-failure is redundant —
    // the cron picks up the next eligible number on its next tick (~60s).
    // fireCall's catch path already flipped the failed number to pending_retry
    // (or unreached at max_attempts). Pausing here would force unnecessary
    // operator intervention on every transient originate-shim hiccup.
    //
    // Safety stack remains: max_attempts cap, suppression list checked per
    // dial, scheduler resume sweep self-heals to `completed` when truly done.
    // Operator can manually Pause if they spot runaway in the dashboard.
    return NextResponse.json(
      {
        error: "Initial dial failed; cron will resume on the next tick.",
        waiting: true,
      },
      { status: 500 },
    );
  }
}

function getBaseUrl(request: NextRequest): string {
  const host = request.headers.get("host") || "localhost:3001";
  const proto = request.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}`;
}
