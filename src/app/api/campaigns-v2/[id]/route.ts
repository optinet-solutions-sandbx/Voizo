import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { performCampaignVapiCleanup } from "@/lib/vapi/campaignVapiCleanup";
import { fetchCampaignV2 } from "@/lib/campaignV2Data";
import { rejectIfCrossOriginStrict } from "@/lib/csrf";
import { normalizeOperatorControls } from "@/lib/campaignV2Shared";

/**
 * GET /api/campaigns-v2/[id]
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md). Returns a single
 * campaign's config row, read SERVER-SIDE via the service role, replacing the
 * detail page's anon fetchCampaignV2(id). Auth-gated (behind Basic Auth). No
 * strict origin check on the GET (browsers omit Origin on same-origin GETs —
 * memory csrf-origin-check-get-lenient).
 *
 * fetchCampaignV2 uses `.single()`, which throws when the id matches no row;
 * we surface that (and any read error) as 404, matching how the detail page
 * handled the old anon throw ("Campaign not found").
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }
  try {
    const campaign = await fetchCampaignV2(id);
    return NextResponse.json(campaign);
  } catch {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * PATCH /api/campaigns-v2/[id]
 * body: { retryIntervalMinutes?, maxAttempts?, dailyCap?, smsLastResortTemplate? }
 *
 * Always-on section's settings drawer (2026-07-10). Edits a RECURRING PARENT's
 * next-child knobs only — children copy the parent row at every spawn, so a
 * change here applies from tomorrow's campaign with no deploy. Today's
 * already-spawned child keeps the settings it was born with.
 *
 * Scope guards:
 *  - recurring parents only (the drawer's surface; fixed campaigns keep the
 *    delete-and-recreate path).
 *  - retry/max/cap validated by the same whitelist the wizard uses
 *    (normalizeOperatorControls); the `realtime` flag is deliberately NOT
 *    accepted — mode changes go through recreate, never a quick edit.
 *  - dailyCap: explicit null clears the cap, but NOT on a realtime parent
 *    (the cap is its cost brake — mirrors the wizard's create rule).
 *  - smsLastResortTemplate: non-empty string sets it; null/"" clears it
 *    (feature off). Inert on verbal_yes campaigns by design (dispatch + sweep
 *    both check the consent mode).
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  let body: {
    retryIntervalMinutes?: unknown;
    maxAttempts?: unknown;
    dailyCap?: unknown;
    smsLastResortTemplate?: unknown;
  };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // select * — deploy-order-safe read (missing new columns are simply absent).
  const { data: row, error: rowErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("*")
    .eq("id", id)
    .single();
  if (rowErr || !row) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }
  if ((row.campaign_type as string) !== "recurring") {
    return NextResponse.json(
      { error: "Settings edits apply to recurring/real-time parents only." },
      { status: 400 },
    );
  }

  const update: Record<string, unknown> = {
    // Same whitelist as campaign create; `realtime` is not forwarded.
    ...normalizeOperatorControls({
      retryIntervalMinutes: body.retryIntervalMinutes as number | undefined,
      maxAttempts: body.maxAttempts as number | undefined,
      dailyCap: body.dailyCap as number | null | undefined,
    }),
  };

  if (body.dailyCap === null) {
    if (row.realtime === true) {
      return NextResponse.json(
        { error: "Real-time campaigns need a daily cap — it's the cost brake." },
        { status: 400 },
      );
    }
    update.daily_cap = null;
  }

  if (typeof body.smsLastResortTemplate === "string") {
    const t = body.smsLastResortTemplate.trim();
    update.sms_last_resort_template = t.length > 0 ? t : null;
  } else if (body.smsLastResortTemplate === null) {
    update.sms_last_resort_template = null;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "No valid settings in the request (out-of-range values are rejected)." },
      { status: 400 },
    );
  }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("campaigns_v2")
    .update(update)
    .eq("id", id)
    .select("*")
    .single();
  if (updateErr || !updated) {
    console.error(`[campaigns-v2] settings PATCH failed for ${id}:`, updateErr);
    return NextResponse.json({ error: "Failed to update settings" }, { status: 500 });
  }

  console.log(
    `[campaigns-v2] parent settings updated: campaign=${id} fields=${Object.keys(update).join(",")}`,
  );
  return NextResponse.json(updated);
}

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
