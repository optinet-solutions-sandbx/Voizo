import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList } from "@/lib/campaignV2Shared";
import { executeRebindCore } from "@/lib/vapi/rebindCore";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";
import { parseJsonBody } from "@/lib/jsonBody";

// Up to: paginated customer.io fetch (~10-30s, segments under 500), three
// Supabase diff queries, two soft-mark UPDATEs, optional Vapi rebind chain
// (clone + lease + patch + UPDATE). 60s budget mirrors duplicate/refresh.
export const maxDuration = 60;

const RESUMABLE_STATUSES = new Set(["inactive", "paused"]);
const RECENT_CALL_WINDOW_DAYS = 7;

/**
 * POST /api/campaigns-v2/[id]/resume
 *
 * Resumes a paused or inactive campaign with operator-chosen skip strategy
 * over the three resume-diff buckets. Mirrors the diff computation from
 * GET /resume-diff, then:
 *
 *   1. Soft-marks the phones the operator chose to skip:
 *      - skip_recently_called=true → outcome='recently_called_elsewhere'
 *      - skip_out_of_segment=true  → outcome='removed_from_segment'
 *      - skip_suppressed=true      → no DB action (dialer.ts:121-156 skips
 *                                    suppressed phones at dial time
 *                                    regardless; the flag is a UI affordance)
 *
 *   2. Always calls executeRebindCore (Phase 4 of the SIP-slot release design
 *      unified the paused and inactive paths). Pre-rebind cleanup hook handles
 *      "old-shape paused" rows (those with non-null vapi_pool_slot_id from
 *      pre-Phase-0 data) by releasing the stale slot + deleting the stale
 *      clone before the rebind acquires fresh ones — §6.6 of the design doc.
 *      For "new-shape paused" (Phase 0+ flag-on data with null pointers)
 *      and inactive, the hook is a no-op via idempotent null-input guard.
 *
 * Body:
 *   {
 *     skip_suppressed?: boolean,         // default true (no-op anyway)
 *     skip_recently_called?: boolean,    // default false
 *     skip_out_of_segment?: boolean,     // default false
 *     worker_slot?: number | "auto",     // only meaningful for inactive path;
 *                                        // numeric not yet supported (Phase 2)
 *   }
 *
 * Returns:
 *   {
 *     resumed: true,
 *     campaignId, campaignName, previousStatus, leasedAt,
 *     softMarked: { recentlyCalled: number, outOfSegment: number },
 *     // For inactive (rebind) path only:
 *     newAssistantId?, newPoolSlotId?, newSipUri?, slotLabel?,
 *     warning?
 *   }
 *
 * Concurrency: soft-mark UPDATEs and the rebind core are not transactional
 * together. If a race occurs (operator double-clicks resume), the rebindCore's
 * .eq("status", "inactive") guard returns 409 cleanly. Soft-marks are
 * idempotent (re-running with the same bucket set produces the same final
 * outcome).
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.7
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §7
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

  // ── Body parse ──
  type ResumeBody = {
    skip_suppressed?: unknown;
    skip_recently_called?: unknown;
    skip_out_of_segment?: unknown;
    worker_slot?: unknown;
  };
  let body: ResumeBody;
  try {
    body = (await parseJsonBody(request)) as ResumeBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const skipRecentlyCalled = body.skip_recently_called === true;
  const skipOutOfSegment = body.skip_out_of_segment === true;
  // skip_suppressed default true; no-op either way (dialer handles).
  const requestedWorkerSlot =
    typeof body.worker_slot === "number"
      ? body.worker_slot
      : body.worker_slot === "auto"
      ? "auto"
      : undefined;

  // ── 1. Read source campaign ──
  // Single string literal for the SELECT — concatenation defeats Supabase's
  // TypeScript inference, per the lesson from Step 5b.
  // vapi_assistant_id + vapi_pool_slot_id added in Phase 4 so the §6.6
  // pre-rebind cleanup hook can detect "old-shape paused" rows.
  const { data: source, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, segment_id, base_assistant_id, voice_id, system_prompt, vapi_assistant_id, vapi_pool_slot_id, agent_mode, script_id")
    .eq("id", id)
    .single();

  if (selectErr || !source) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!RESUMABLE_STATUSES.has(source.status as string)) {
    return NextResponse.json(
      {
        error:
          source.status === "running"
            ? "Campaign is already running."
            : `Cannot resume a ${source.status} campaign. Only inactive and paused are resumable.`,
        resumed: false,
      },
      { status: 400 },
    );
  }

  // ── 2. Read pending phones ──
  const { data: pendingRows, error: pendingErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("phone_e164")
    .eq("campaign_id", id)
    .in("outcome", ["pending", "pending_retry"]);

  if (pendingErr) {
    return NextResponse.json({ error: "Failed to read pending numbers" }, { status: 500 });
  }

  const pendingPhones = (pendingRows ?? []).map((r) => r.phone_e164 as string);

  if (pendingPhones.length > 1000) {
    return NextResponse.json(
      {
        error:
          `Pending set is ${pendingPhones.length} phones; current diff implementation caps at 1000.`,
      },
      { status: 413 },
    );
  }

  // ── 3. Compute the buckets we need (only the ones the operator wants to act on) ──
  // Suppressed is informational; we compute it for the audit log but don't
  // soft-mark. recentlyCalled and outOfSegment we compute only if their
  // respective skip flag is true (avoids unnecessary work).
  let recentSet = new Set<string>();
  const outOfSegmentSet = new Set<string>();

  if (pendingPhones.length > 0 && skipRecentlyCalled) {
    const recentCutoffIso = new Date(
      Date.now() - RECENT_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: recentRows, error: recentErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .neq("campaign_id", id)
      .in("phone_e164", pendingPhones)
      .in("outcome", CONTACT_OUTCOMES)
      .gt("last_attempted_at", recentCutoffIso);
    if (recentErr) {
      return NextResponse.json(
        { error: "Failed to compute recent-call bucket" },
        { status: 500 },
      );
    }
    recentSet = new Set((recentRows ?? []).map((r) => r.phone_e164 as string));
  }

  if (pendingPhones.length > 0 && skipOutOfSegment) {
    if (source.segment_id == null) {
      return NextResponse.json(
        {
          error:
            "skip_out_of_segment=true requires a source segment, but this campaign has none " +
            "(multi-segment import or pre-Step-5a campaign). Pass skip_out_of_segment=false.",
          resumed: false,
        },
        { status: 400 },
      );
    }
    const segmentResult = await fetchSegmentPhones(source.segment_id as number);
    if (!segmentResult.ok) {
      return NextResponse.json(
        { error: `Customer.io fetch failed: ${segmentResult.error}` },
        { status: segmentResult.status },
      );
    }
    const segmentSet = new Set(parsePhoneList(segmentResult.phones.join("\n")));
    for (const phone of pendingPhones) {
      if (!segmentSet.has(phone)) outOfSegmentSet.add(phone);
    }
  }

  // ── 4. Apply soft-marks ──
  // Each UPDATE is guarded by outcome IN ('pending','pending_retry') so that
  // if another process moved the row past pending in the meantime, we skip
  // it (no clobbering of dialed outcomes). Returning count='exact' so we
  // can report actual rows touched in the response.
  let softMarkedRecentlyCalled = 0;
  let softMarkedOutOfSegment = 0;

  if (recentSet.size > 0) {
    const { error: updateErr, count } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "recently_called_elsewhere" }, { count: "exact" })
      .eq("campaign_id", id)
      .in("outcome", ["pending", "pending_retry"])
      .in("phone_e164", Array.from(recentSet));
    if (updateErr) {
      console.error(`[campaigns-v2/resume] recently_called soft-mark failed:`, updateErr);
      return NextResponse.json(
        { error: "Failed to soft-mark recently-called phones", resumed: false },
        { status: 500 },
      );
    }
    softMarkedRecentlyCalled = count ?? 0;
  }

  if (outOfSegmentSet.size > 0) {
    const { error: updateErr, count } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "removed_from_segment" }, { count: "exact" })
      .eq("campaign_id", id)
      .in("outcome", ["pending", "pending_retry"])
      .in("phone_e164", Array.from(outOfSegmentSet));
    if (updateErr) {
      console.error(`[campaigns-v2/resume] out_of_segment soft-mark failed:`, updateErr);
      // recently_called soft-mark already landed (if applicable). Partial
      // state — return 500 with what we did. Operator re-runs resume; the
      // recently_called UPDATE is idempotent (those rows are no longer
      // 'pending', won't match the WHERE clause).
      return NextResponse.json(
        {
          error: "Failed to soft-mark out-of-segment phones",
          resumed: false,
          partial: true,
          softMarkedRecentlyCalled,
        },
        { status: 500 },
      );
    }
    softMarkedOutOfSegment = count ?? 0;
  }

  // ── 5. Restart dialing via executeRebindCore (unified path) ──
  // Phase 4: both paused and inactive resumes go through the rebind path.
  // For "old-shape paused" (pre-Phase-0 data with non-null vapi pointers),
  // run the pre-rebind cleanup hook first so we don't orphan the stale slot
  // + clone when leaseSlot acquires fresh ones. The helper is idempotent on
  // null inputs, so "new-shape paused" (Phase 0+ flag-on data with null
  // pointers) and inactive campaigns no-op safely through it.
  const previousStatus = source.status as string;
  const campaignName = source.name as string;

  if (!source.base_assistant_id) {
    return NextResponse.json(
      {
        error:
          "Campaign has no base_assistant_id. Pick a base agent on the campaign detail page first.",
        resumed: false,
        partial: true,
        softMarkedRecentlyCalled,
        softMarkedOutOfSegment,
      },
      { status: 400 },
    );
  }

  const vapiKey = process.env.VAPI_PRIVATE_KEY;
  if (!vapiKey) {
    return NextResponse.json(
      { error: "VAPI_PRIVATE_KEY is not set" },
      { status: 500 },
    );
  }

  // ── 5a. §6.6 pre-rebind cleanup hook ──
  // Detects "old-shape paused" rows where the slot + clone are still
  // alive (vapi_pool_slot_id non-null). Without this, the next rebind
  // would lease a SECOND slot and leave the original one orphaned.
  // Idempotent: null inputs → no-op fast path.
  const preCleanup = await performCampaignVapiCleanup(supabaseAdmin, {
    vapiKey,
    campaignName,
    vapiAssistantId: source.vapi_assistant_id as string | null,
    vapiPoolSlotId: source.vapi_pool_slot_id as string | null,
  });
  if (preCleanup.vapiWarnings.length > 0) {
    console.warn(
      `[campaigns-v2/resume] pre-rebind cleanup warnings for ${campaignName}:`,
      preCleanup.vapiWarnings,
    );
  }

  // ── 5b. Rebind ──
  const result = await executeRebindCore(supabaseAdmin, vapiKey, {
    id: id,
    name: campaignName,
    base_assistant_id: source.base_assistant_id as string,
    voice_id: (source.voice_id as string | null) ?? null,
    system_prompt: source.system_prompt as string,
    agent_mode: (source.agent_mode as "assistant" | "script" | null) ?? null,
    script_id: (source.script_id as string | null) ?? null,
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        error: result.error,
        resumed: false,
        partial: true,
        softMarkedRecentlyCalled,
        softMarkedOutOfSegment,
      },
      { status: result.status },
    );
  }

  const slotLabel = `voizo-sip-pool-slot-${String(result.slot.slot_index).padStart(2, "0")}`;
  const rebindResult = {
    newAssistantId: result.clone.id,
    newAssistantName: result.clone.name,
    newPoolSlotId: result.slot.id,
    newSipUri: result.slot.sip_uri,
    slotLabel,
    leasedAt: result.leasedAt,
  };

  // ── 6. Audit + response ──
  const warning =
    typeof requestedWorkerSlot === "number"
      ? `targeted worker_slot=${requestedWorkerSlot} requested but targeted lease is not yet supported; used auto`
      : undefined;

  console.log(
    `[campaigns-v2/resume] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName,
      previousStatus,
      softMarkedRecentlyCalled,
      softMarkedOutOfSegment,
      newAssistantId: rebindResult.newAssistantId,
      newPoolSlotId: rebindResult.newPoolSlotId,
      slotLabel: rebindResult.slotLabel,
      requestedWorkerSlot: requestedWorkerSlot ?? null,
      timestamp: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    resumed: true,
    campaignId: id,
    campaignName,
    previousStatus,
    softMarked: {
      recentlyCalled: softMarkedRecentlyCalled,
      outOfSegment: softMarkedOutOfSegment,
    },
    ...rebindResult,
    // Surface pre-rebind cleanup warnings so the operator UI can flag
    // stale Vapi resources (e.g., an old slot that landed in 'maintenance'
    // because the PATCH-null failed). Code-review feedback (2026-05-25):
    // these were only console.warn'd before — operators had no signal that
    // a resume left orphan resources behind. Heartbeat Rule 4 still retries
    // maintenance recovery at 6h; this is informational, not load-bearing.
    ...(preCleanup.vapiWarnings.length > 0
      ? { preRebindWarnings: preCleanup.vapiWarnings }
      : {}),
    ...(warning ? { warning } : {}),
  });
}
