import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { executeRebindCore } from "@/lib/vapi/rebindCore";
import { parseJsonBody } from "@/lib/jsonBody";

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
 * Heavy lifting lives in executeRebindCore (src/lib/vapi/rebindCore.ts),
 * extracted on 2026-05-18 when Step 7 (Resume) became the second caller of
 * the same logic. This route is now a thin adapter: input validation +
 * authorization + helper call + audit log + response.
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
 * Failure rollback strategy (handled by executeRebindCore):
 *   - createClone fails              → return helper's status/error verbatim
 *   - leaseSlot returns null (full)  → DELETE the clone, 503
 *   - patchPhoneAssistant fails      → releaseSlot + DELETE clone, 502
 *   - linkSlot RPC returns false     → log warning, continue
 *   - Final UPDATE matches 0 rows    → 409
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
    const body = await parseJsonBody(request);
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
    .select("id, name, status, base_assistant_id, voice_id, system_prompt, agent_mode, script_id")
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

  // ── 3. Execute the rebind core ──
  const result = await executeRebindCore(supabaseAdmin, vapiKey, {
    id: campaign.id as string,
    name: campaign.name as string,
    base_assistant_id: campaign.base_assistant_id as string,
    voice_id: (campaign.voice_id as string | null) ?? null,
    system_prompt: campaign.system_prompt as string,
    agent_mode: (campaign.agent_mode as "assistant" | "script" | null) ?? null,
    script_id: (campaign.script_id as string | null) ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, rebound: false },
      { status: result.status },
    );
  }

  const slotLabel = `voizo-sip-pool-slot-${String(result.slot.slot_index).padStart(2, "0")}`;

  // Audit log — structured single line for post-incident review.
  console.log(
    `[campaigns-v2/rebind] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName: campaign.name,
      previousStatus: "inactive",
      newAssistantId: result.clone.id,
      newPoolSlotId: result.slot.id,
      slotLabel,
      requestedWorkerSlot: requestedWorkerSlot ?? null,
      timestamp: result.leasedAt,
    }),
  );

  const warning =
    typeof requestedWorkerSlot === "number"
      ? `targeted worker_slot=${requestedWorkerSlot} requested but targeted lease is not yet supported; used auto (${slotLabel})`
      : undefined;

  return NextResponse.json({
    rebound: true,
    campaignId: id,
    campaignName: campaign.name,
    previousStatus: "inactive",
    newAssistantId: result.clone.id,
    newAssistantName: result.clone.name,
    newPoolSlotId: result.slot.id,
    newSipUri: result.slot.sip_uri,
    slotLabel,
    leasedAt: result.leasedAt,
    ...(warning ? { warning } : {}),
  });
}
