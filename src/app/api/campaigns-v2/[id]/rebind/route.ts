import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { createClone } from "@/lib/vapi/cloneAssistant";
import { leaseSlot, linkSlot, patchPhoneAssistant, releaseSlot } from "@/lib/vapi/sipPool";

// Vapi cleanup chains up to 4 HTTP calls (GET base, POST new clone, PATCH slot,
// optional rollback DELETE on failure). 30s mirrors the stop and eject budgets.
export const maxDuration = 30;

/**
 * POST /api/campaigns-v2/[id]/rebind
 *
 * Inverse of Eject. Takes an `inactive` campaign whose base_assistant_id +
 * voice_id + system_prompt were preserved through the prior eject, re-clones
 * the base assistant, leases a fresh SIP pool slot, binds the slot's phone
 * to the new clone, and flips status back to `running`.
 *
 * Request body:
 *   { worker_slot?: number | "auto" }
 *
 * Returns on success:
 *   { rebound: true, campaignId, newAssistantId, newPoolSlotId, newSipUri,
 *     previousStatus, leasedAt, [warning] }
 *
 * Guards:
 *   - Origin check: URL-parsed exact host equality (matches eject/stop pattern)
 *   - Status MUST be 'inactive' (400 otherwise)
 *   - base_assistant_id MUST be non-null. Campaigns created before Phase 1
 *     Step 2 (commit 486df45) have base_assistant_id NULL and can't be
 *     rebound until the operator fills the field (operator-fill message
 *     per task tracker section 4 step 1).
 *
 * Failure rollback strategy:
 *   - createClone fails              → return helper's status/error verbatim,
 *                                       no state changes
 *   - leaseSlot returns null (full)  → DELETE the just-created clone, 503
 *   - patchPhoneAssistant fails      → releaseSlot + DELETE clone, 502
 *   - linkSlot RPC returns false     → log warning, continue (heartbeat
 *                                       resolves the orphan slot)
 *   - Final UPDATE matches 0 rows    → 409 (stuck state: clone + slot exist
 *                                       on Vapi but campaign row didn't
 *                                       flip — operator-resolvable via
 *                                       Eject again, which is idempotent in
 *                                       this state)
 *
 * Targeted worker_slot (e.g., "give me Worker 03") is NOT yet supported —
 * the existing lease_vapi_sip_slot RPC picks the lowest-numbered free slot.
 * When a numeric worker_slot is passed, this endpoint silently uses auto
 * and includes a 'warning' field in the response so operators see the
 * fallback explicitly. Real targeted lease is a Phase 2 follow-up (needs
 * a new RPC).
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §4.3
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §4
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Origin check (URL-parsed exact host equality) ──
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

  // ── Body parse (optional) ──
  let requestedWorkerSlot: number | "auto" | undefined;
  try {
    const body = await request.json().catch(() => ({}));
    const ws = (body as { worker_slot?: unknown })?.worker_slot;
    if (typeof ws === "number") {
      requestedWorkerSlot = ws;
    } else if (ws === "auto") {
      requestedWorkerSlot = "auto";
    }
  } catch {
    // Body is optional; ignore parse errors
  }

  // ── 1. Read campaign + validate status + base_assistant_id ──
  const { data: campaign, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, base_assistant_id, voice_id, system_prompt")
    .eq("id", id)
    .single();

  if (selectErr || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (campaign.status !== "inactive") {
    return NextResponse.json(
      {
        error:
          campaign.status === "running"
            ? "Campaign is already running."
            : `Cannot rebind a ${campaign.status} campaign. Eject it first to mark it inactive.`,
        rebound: false,
      },
      { status: 400 },
    );
  }

  if (!campaign.base_assistant_id) {
    return NextResponse.json(
      {
        error:
          "This campaign was created before resume support landed. " +
          "Pick a base agent on the campaign detail page first.",
        rebound: false,
      },
      { status: 400 },
    );
  }

  // ── 2. Env check ──
  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    return NextResponse.json(
      { error: "VAPI_PRIVATE_KEY is not set" },
      { status: 500 },
    );
  }

  // ── 3. Re-clone via shared helper ──
  // voice_id NULL on the row → undefined override → clone inherits base.voice
  // (same fallback as create flow when operator skips the voice picker).
  const cloneResult = await createClone(vapiKey, campaign.base_assistant_id as string, {
    voiceId: (campaign.voice_id as string | null) ?? undefined,
    systemPrompt: (campaign.system_prompt as string) ?? undefined,
    campaignName: (campaign.name as string) ?? undefined,
  });

  if (!cloneResult.ok) {
    return NextResponse.json(
      { error: cloneResult.error, rebound: false },
      { status: cloneResult.status },
    );
  }

  const clone = cloneResult.clone;

  // ── 4. Lease a slot (auto only for now — targeted not yet supported) ──
  const slot = await leaseSlot(supabaseAdmin, clone.id);

  if (!slot) {
    // Pool exhausted. Roll back the clone (mirror clone-assistant/route.ts pattern).
    console.warn(`[campaigns-v2/rebind] SIP pool exhausted; rolling back clone ${clone.id}`);
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    }).catch(() => {});
    return NextResponse.json(
      {
        error:
          "All SIP pool slots are in use. Eject a running campaign first, or wait for one to complete.",
        rebound: false,
      },
      { status: 503 },
    );
  }

  // ── 5. PATCH slot's phone to point at the new clone ──
  const patchRes = await patchPhoneAssistant(vapiKey, slot.vapi_phone_number_id, clone.id);
  if (!patchRes.ok) {
    console.error(`[campaigns-v2/rebind] Vapi PATCH failed:`, patchRes.body.slice(0, 500));
    await releaseSlot(supabaseAdmin, slot.id).catch(() => {});
    await fetch(`https://api.vapi.ai/assistant/${clone.id}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${vapiKey}` },
    }).catch(() => {});
    return NextResponse.json(
      { error: `Failed to bind SIP slot: ${patchRes.body.slice(0, 200)}`, rebound: false },
      { status: 502 },
    );
  }

  // ── 6. Back-link slot → campaign (same pattern as createCampaignV2) ──
  const linked = await linkSlot(supabaseAdmin, {
    slotId: slot.id,
    campaignId: id,
    expectedAssistantId: clone.id,
  });
  if (!linked) {
    console.warn(
      `[campaigns-v2/rebind] linkSlot returned false for slot ${slot.id} ` +
      `(campaign ${id}, assistant ${clone.id}). Heartbeat will reconcile.`,
    );
  }

  // ── 7. Terminal status flip ──
  // .eq("status", "inactive") guards against an unexpected concurrent state
  // change. If 0 rows match, the new clone + slot are live on Vapi but the
  // DB row didn't flip — operator can run Eject again (idempotent on this
  // state: clone GET → 404 silently, slot release returns false silently,
  // UPDATE succeeds on the inactive row that's now non-inactive). 409 lets
  // the operator see the stuck state explicitly.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update({
      vapi_assistant_id: clone.id,
      vapi_pool_slot_id: slot.id,
      vapi_sip_uri: slot.sip_uri,
      status: "running",
      last_resumed_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "inactive")
    .select("id")
    .single();

  if (updateErr || !updated) {
    console.error(`[campaigns-v2/rebind] status flip lost the race for ${id}:`, updateErr);
    return NextResponse.json(
      {
        error:
          "Campaign status changed during rebind (someone else acted on this campaign). " +
          "The new clone and slot are live on Vapi. Eject the campaign again to reconcile.",
        rebound: false,
      },
      { status: 409 },
    );
  }

  const campaignName = (campaign.name as string) ?? id;
  const leasedAt = new Date().toISOString();
  const slotLabel = `voizo-sip-pool-slot-${String(slot.slot_index).padStart(2, "0")}`;

  // Audit log — structured single line for post-incident review.
  console.log(
    `[campaigns-v2/rebind] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName,
      previousStatus: "inactive",
      newAssistantId: clone.id,
      newPoolSlotId: slot.id,
      slotLabel,
      requestedWorkerSlot: requestedWorkerSlot ?? null,
      timestamp: leasedAt,
    }),
  );

  const warning =
    typeof requestedWorkerSlot === "number"
      ? `targeted worker_slot=${requestedWorkerSlot} requested but targeted lease is not yet supported; used auto (${slotLabel})`
      : undefined;

  return NextResponse.json({
    rebound: true,
    campaignId: id,
    campaignName,
    previousStatus: "inactive",
    newAssistantId: clone.id,
    newAssistantName: clone.name,
    newPoolSlotId: slot.id,
    newSipUri: slot.sip_uri,
    slotLabel,
    leasedAt,
    ...(warning ? { warning } : {}),
  });
}
