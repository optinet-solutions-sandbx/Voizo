import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";

// `inactive` is deletable too: by definition, an inactive campaign has
// already had its Vapi cleanup done (via eject), so DELETE is the safest
// possible path — the shared helper sees null pointers and no-ops, leaving
// a clean cascade-DELETE in the database. Without `inactive` here, the
// operator workflow was Resume → Pause → Delete, which wastefully re-leased
// a SIP slot just to discard the campaign.
const DELETABLE_STATUSES = new Set(["draft", "paused", "completed", "archived", "inactive"]);

/**
 * DELETE /api/campaigns-v2/[id]
 *
 * Deletes a Campaign V2 and all child rows (numbers, calls, SMS)
 * via Postgres ON DELETE CASCADE. Also cleans up the cloned Vapi
 * assistant and its SIP phone number so no orphans are left.
 *
 * Guards:
 * - Origin check: only same-origin requests accepted (blocks external tooling)
 * - Status whitelist: only draft/paused/completed/archived campaigns deletable
 */
export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host && !origin.includes(host)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { id } = await params;

  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  const { data: campaign, error } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, vapi_assistant_id, vapi_pool_slot_id")
    .eq("id", id)
    .single();

  if (error || !campaign) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!DELETABLE_STATUSES.has(campaign.status)) {
    const guidance =
      campaign.status === "running"
        ? "Pause it first."
        : "This status is not deletable.";
    return NextResponse.json(
      { error: `Cannot delete a ${campaign.status} campaign. ${guidance}` },
      { status: 400 },
    );
  }

  // Clean up Vapi resources via shared helper.
  // Helper at src/lib/vapi/campaignVapiCleanup.ts is bit-exact behaviorally
  // equivalent to the previous inline block — pool path (PATCH null +
  // release-or-maintenance), legacy path (phone DELETE), voizoClone-guarded
  // clone DELETE. The 2026-05-15 base-agent-safety guard is preserved inside
  // the helper. See campaigns-v2/[id]/route.ts pre-refactor git history (or
  // the helper module's docstring) for the original incident commentary.
  const vapiKey = process.env.VAPI_PRIVATE_KEY ?? "";
  const { slotReleased, vapiWarnings } = await performCampaignVapiCleanup(
    supabaseAdmin,
    {
      vapiKey,
      campaignName: (campaign.name as string) ?? id,
      vapiAssistantId: campaign.vapi_assistant_id as string | null,
      vapiPoolSlotId: campaign.vapi_pool_slot_id as string | null,
    },
  );

  const { error: deleteErr } = await supabaseAdmin
    .from("campaigns_v2")
    .delete()
    .eq("id", id);

  if (deleteErr) {
    console.error("[campaigns-v2] delete failed:", deleteErr);
    return NextResponse.json({ error: "Failed to delete campaign" }, { status: 500 });
  }

  if (vapiWarnings.length > 0) {
    console.warn("[campaigns-v2] vapi cleanup warnings:", vapiWarnings);
  }

  return NextResponse.json({
    deleted: true,
    vapiWarnings,
    ...(slotReleased ? { slotReleased } : {}),
  });
}
