import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";

// Vapi cleanup chains up to 3 HTTP calls (PATCH phone detach, GET clone inspect,
// DELETE clone). 30s mirrors the stop endpoint's defensive budget.
export const maxDuration = 30;

const EJECTABLE_STATUSES = ["draft", "paused", "completed", "archived"] as const;
type EjectableStatus = (typeof EJECTABLE_STATUSES)[number];
const EJECTABLE_SET = new Set<string>(EJECTABLE_STATUSES);

/**
 * POST /api/campaigns-v2/[id]/eject
 *
 * Releases a campaign's SIP slot and deletes its Vapi clone while
 * PRESERVING the campaign row + all dial/call/SMS history. Status flips
 * from {draft, paused, completed, archived} → 'inactive'. The inverse
 * of Re-bind (Phase 1 Step 4, not yet shipped).
 *
 * Differs from DELETE /api/campaigns-v2/[id]:
 *   - DELETE drops campaigns_v2 + cascade-drops campaign_numbers_v2,
 *     calls_v2, sms_messages_v2. Permanent.
 *   - Eject keeps all of that; only clears the three Vapi-pointer fields
 *     (vapi_assistant_id, vapi_pool_slot_id, vapi_sip_uri) so the slot
 *     can be re-leased and the campaign stays cleanly resumable.
 *
 * The Vapi-cleanup block below is intentionally duplicated from the
 * DELETE handler at campaigns-v2/[id]/route.ts:50-175 (same shape: pool
 * path PATCH+release-or-maintenance, legacy path phone-number delete,
 * voizoClone-guarded clone delete). Per the 2026-05-18 working
 * agreement: extraction is deferred until a third caller justifies it.
 *
 * Guards:
 *   - Origin check: URL-parsed exact host equality (matches stop/route.ts
 *     pattern; the older origin.includes(host) used by the DELETE handler
 *     is bypassable via subdomain confusion).
 *   - Status whitelist: only {draft, paused, completed, archived} ejectable.
 *     A `running` campaign must be paused first.
 *   - Atomic terminal UPDATE: re-checks status IN whitelist in the WHERE
 *     clause. Protects against an operator-clicked Resume between our
 *     SELECT and UPDATE — 0 rows matched → 409 (the Vapi cleanup already
 *     ran, but the campaign row is left in whatever state Resume put it).
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §4.3, §4.4
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §3
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

  // ── 1. Read the campaign and validate status ──
  const { data: campaign, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("id", id)
    .single();

  if (selectErr || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!EJECTABLE_SET.has(campaign.status as string)) {
    const friendly =
      campaign.status === "running"
        ? "Cannot eject a running campaign. Pause it first."
        : campaign.status === "inactive"
          ? "Campaign is already inactive."
          : `Cannot eject a ${campaign.status} campaign.`;
    return NextResponse.json({ error: friendly, ejected: false }, { status: 400 });
  }

  const campaignName = (campaign.name as string) ?? id;
  const previousStatus = campaign.status as EjectableStatus;

  // ── 2. Vapi cleanup via shared helper ──
  // Helper at src/lib/vapi/campaignVapiCleanup.ts is bit-exact behaviorally
  // equivalent to the previous inline block. Two paths inside (pool vs
  // legacy) routed by data, voizoClone safety guard preserved.
  const vapiKey = process.env.VAPI_PRIVATE_KEY ?? "";
  const { slotReleased, vapiWarnings } = await performCampaignVapiCleanup(
    supabaseAdmin,
    {
      vapiKey,
      campaignName,
      vapiAssistantId: campaign.vapi_assistant_id as string | null,
      vapiPoolSlotId: campaign.vapi_pool_slot_id as string | null,
    },
  );

  // ── 3. Terminal status flip ──
  // .in("status", EJECTABLE_STATUSES) guards against an operator-clicked
  // Resume that flipped the row to 'running' while we were doing Vapi work.
  // If 0 rows match here, the Vapi cleanup already happened but the DB row
  // moved on — return 409 so the operator can re-sync from the dashboard.
  // base_assistant_id, system_prompt, timezone, name, callWindows etc. are
  // all preserved by virtue of not appearing in the SET clause.
  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update({
      status: "inactive",
      vapi_assistant_id: null,
      vapi_pool_slot_id: null,
      vapi_sip_uri: null,
    })
    .eq("id", id)
    .in("status", EJECTABLE_STATUSES as unknown as string[])
    .select("id")
    .single();

  if (updateErr || !updated) {
    console.error(`[campaigns-v2/eject] status flip lost the race for ${id}:`, updateErr);
    return NextResponse.json(
      {
        error:
          "Campaign status changed during eject (someone clicked Resume?). " +
          "Vapi cleanup may have partially completed — refresh the dashboard and retry if needed.",
        ejected: false,
      },
      { status: 409 },
    );
  }

  if (vapiWarnings.length > 0) {
    console.warn(
      `[campaigns-v2/eject] vapi cleanup warnings for ${campaignName}:`,
      vapiWarnings,
    );
  }

  // Audit log — structured single line for post-incident review.
  console.log(
    `[campaigns-v2/eject] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName,
      previousStatus,
      slotReleased,
      vapiWarnings,
      timestamp: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    ejected: true,
    campaignId: id,
    campaignName,
    previousStatus,
    ...(slotReleased ? { slotReleased } : {}),
    vapiWarnings,
  });
}
