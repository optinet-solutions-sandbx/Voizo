import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { pauseReleasesSlot } from "@/lib/featureFlags";

// In-flight Vapi call termination may issue 1 HTTP DELETE per active call.
// Queue gate at 1 means typically max 1 termination; defensive 30s budget.
export const maxDuration = 30;

/**
 * POST /api/campaigns-v2/[id]/stop
 *
 * Emergency stop — flips a `running` campaign to `paused` immediately AND
 * marks any non-terminal calls_v2 rows as `canceled`. Differs from Pause
 * (which keeps calls_v2 rows untouched).
 *
 * Honest scope (2026-05-11): this stops the QUEUE — no new dials fire
 * after the status flip lands. Any call currently in progress will end
 * naturally via the existing silenceTimeoutSeconds=30 + bgapi unwind path
 * (~60s worst case). We do NOT terminate the live audio session in this
 * release; capturing vapi_call_id at originate time (rather than waiting
 * for the Vapi end-of-call webhook) is a Phase 1 follow-up.
 *
 * For 12-player Canadian go-live: queue gate caps in-flight calls at 1,
 * so worst-case "still being talked to" exposure after Stop is ~60s on
 * one call. Operationally sufficient kill switch.
 *
 * Pending_retry rows stay queued — operator can resume the campaign via
 * the Start button and retries pick up from where they left off. To fully
 * discard the campaign, use Delete after pausing.
 *
 * Manifesto §6 alignment:
 *   - CSRF guard via strict Origin host equality (not substring).
 *   - Atomic status transition (.eq("status","running")) prevents stomping
 *     a concurrent operator Pause or a sweeper-resolved state.
 *   - State written to DB BEFORE any external API attempt.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Origin check (CSRF guard, stricter than the DELETE handler's substring
  // version which was vulnerable to subdomain bypass like
  // `voizo-eight.vercel.app.attacker.com` containing the host. Parse the
  // Origin URL and require an exact host equality.) ──
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  try {
    const originUrl = new URL(origin);
    if (originUrl.host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  // ── 1. Read the campaign first ──
  // When PAUSE_RELEASES_SLOT is on (Phase 1+), we need vapi_assistant_id
  // and vapi_pool_slot_id BEFORE the UPDATE clears them so the cleanup
  // helper has what it needs. Reading first costs one DB roundtrip but
  // keeps the race-guarded atomic UPDATE intact below.
  const { data: campaign, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("id", id)
    .single();

  if (selectErr || !campaign || campaign.status !== "running") {
    return NextResponse.json(
      {
        error: "Campaign not currently running (already paused / completed / archived, or not found).",
        paused: false,
      },
      { status: 409 },
    );
  }

  const capturedAssistantId = campaign.vapi_assistant_id as string | null;
  const capturedSlotId = campaign.vapi_pool_slot_id as string | null;
  const campaignName = (campaign.name as string) ?? id;

  // ── 2. Atomic status flip: running → paused ──
  // The .eq("status","running") guard prevents stomping a concurrent
  // Pause or a state already resolved by a different path. When the
  // PAUSE_RELEASES_SLOT flag is on, ALSO clear the Vapi pointer fields
  // in the same UPDATE so the campaign row reflects "no longer holding
  // resources" before the cleanup runs.
  const releaseOnPause = pauseReleasesSlot();
  const updatePayload: Record<string, unknown> = { status: "paused" };
  if (releaseOnPause) {
    updatePayload.vapi_assistant_id = null;
    updatePayload.vapi_pool_slot_id = null;
    updatePayload.vapi_sip_uri = null;
    updatePayload.last_paused_at = new Date().toISOString();
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update(updatePayload)
    .eq("id", id)
    .eq("status", "running")
    .select("id")
    .single();

  if (updateErr || !updated) {
    return NextResponse.json(
      {
        error: "Campaign not currently running (already paused / completed / archived, or not found).",
        paused: false,
      },
      { status: 409 },
    );
  }

  console.log(`[campaign-stop] ${campaignName}: status flipped running → paused${releaseOnPause ? " (slot release on)" : ""}`);

  // ── 2. Find in-flight calls + attempt Vapi termination ──
  // Queue gate at 1 means we typically see 0 or 1 in-flight call here.
  // Mark each as canceled in our DB regardless of Vapi outcome (so the
  // dashboard reflects reality), then best-effort terminate via Vapi.
  const { data: inFlightCalls, error: callsErr } = await supabaseAdmin
    .from("calls_v2")
    .select("id, vapi_call_id, provider_call_id")
    .eq("campaign_id", id)
    .in("status", ["initiated", "ringing", "in_progress", "answered"]);

  if (callsErr) {
    console.error(`[campaign-stop] inFlightCalls query failed for ${id}:`, callsErr);
    // Don't fail the whole stop — campaign is already paused, that's the critical part.
  }

  const terminationResults: Array<{
    callId: string;
    vapiCallId: string | null;
    result: string;
  }> = [];

  const vapiKey = process.env.VAPI_PRIVATE_KEY;

  for (const call of inFlightCalls ?? []) {
    const callId = call.id as string;
    const vapiCallId = (call.vapi_call_id as string | null) ?? null;

    // Mark our row canceled FIRST (state-before-action per manifesto §6).
    // Even if Vapi termination fails or there's no vapi_call_id yet, this
    // ensures the dashboard shows the call as terminated and the existing
    // voice-status idempotency guards (status NOT IN terminal list) prevent
    // any late FS webhook from reviving it.
    await supabaseAdmin
      .from("calls_v2")
      .update({
        status: "canceled",
        ended_at: new Date().toISOString(),
      })
      .eq("id", callId);

    if (!vapiKey) {
      terminationResults.push({ callId, vapiCallId, result: "no_vapi_key" });
      continue;
    }

    if (!vapiCallId) {
      // Race: call fired but Vapi hasn't reported the call ID back yet
      // (vapi_call_id is set by end-of-call webhook normally). The campaign
      // status flip above prevents chain-next; the call will end naturally
      // within ~60-90s (silenceTimeoutSeconds=30 + bgapi latency).
      terminationResults.push({ callId, vapiCallId, result: "no_vapi_call_id_yet" });
      continue;
    }

    // Best-effort Vapi termination. Wrapped in try/catch so a Vapi outage
    // doesn't fail the whole stop. The status flip is the operational
    // guarantee; this is the "extra mile" termination.
    try {
      const delRes = await fetch(`https://api.vapi.ai/call/${encodeURIComponent(vapiCallId)}`, {
        method: "DELETE",
        headers: {
          Authorization: `Bearer ${vapiKey}`,
          Accept: "application/json",
        },
      });

      if (delRes.ok) {
        terminationResults.push({ callId, vapiCallId, result: "vapi_terminated" });
        console.log(`[campaign-stop] ${campaignName}: vapi call ${vapiCallId} terminated`);
      } else if (delRes.status === 404) {
        // Vapi already ended the call on its side (e.g., customer hung up
        // moments before operator clicked Stop). Treat as success.
        terminationResults.push({ callId, vapiCallId, result: "vapi_already_ended" });
      } else {
        const errText = await delRes.text().catch(() => "");
        console.warn(
          `[campaign-stop] vapi delete failed for ${vapiCallId} (${delRes.status}): ${errText.slice(0, 200)}`,
        );
        terminationResults.push({ callId, vapiCallId, result: `vapi_failed_${delRes.status}` });
      }
    } catch (err) {
      console.error(`[campaign-stop] vapi delete threw for ${vapiCallId}:`, err);
      terminationResults.push({ callId, vapiCallId, result: "vapi_error" });
    }
  }

  // ── 3. Flag-gated Vapi cleanup (Phase 0 SIP slot release on pause) ──
  // When flag is OFF (default): no-op, clone + slot stay alive (today's behavior).
  // When flag is ON (Phase 1+): release the slot + delete the clone via the
  // shared helper, same as eject path.
  let slotReleased: string | null = null;
  const vapiWarnings: string[] = [];
  if (releaseOnPause) {
    const result = await performCampaignVapiCleanup(supabaseAdmin, {
      vapiKey: vapiKey ?? "",
      campaignName,
      vapiAssistantId: capturedAssistantId,
      vapiPoolSlotId: capturedSlotId,
    });
    slotReleased = result.slotReleased;
    vapiWarnings.push(...result.vapiWarnings);
  }

  // Audit log — structured single line for post-incident review.
  const inFlightCount = inFlightCalls?.length ?? 0;
  console.log(
    `[campaign-stop] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName,
      inFlightCount,
      terminations: terminationResults,
      slotReleased,
      vapiWarnings,
      timestamp: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    paused: true,
    campaignId: id,
    campaignName,
    inFlightCount,
    // Honest note: in-flight calls will end naturally within ~60s; we do
    // not terminate live audio in this release. terminationResults is for
    // future Phase 1 follow-up that wires actual call termination.
    terminations: terminationResults,
    ...(slotReleased ? { slotReleased } : {}),
    ...(vapiWarnings.length > 0 ? { vapiWarnings } : {}),
    note: inFlightCount > 0
      ? `${inFlightCount} in-flight call(s) will end naturally within ~60 seconds.`
      : "No calls were in flight.",
  });
}
