import { NextRequest, NextResponse } from "next/server";
import { rejectIfCrossOriginStrict } from "@/lib/csrf";
import { updateCampaignV2Status } from "@/lib/campaignV2Data";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Allowed status values for this soft-transition endpoint (Jas, 2026-06-05).
// The detail page's handlePause sends "paused"; "running" is also accepted for
// a direct soft resume.
//
// ⚠️ Caveat: a raw flip to "running" here bypasses the slot-lease + queue-gate
// that POST /start enforces (and the eject/rebind flow that /resume runs). It is
// a status-only write — it does NOT lease a worker or fire calls. The richer
// resume paths (/start, /resume) remain the right way to bring a campaign back
// online with a live worker; this endpoint is for the lightweight status flip.
const ALLOWED_STATUSES = new Set(["paused", "running"]);

/**
 * POST /api/campaigns-v2/[id]/status   body: { status: "paused" | "running" }
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md). Replaces the
 * detail page's anon updateCampaignV2Status(id, "paused") with a server-side
 * service-role write (campaignV2Data → supabaseAdmin). Auth-gated (behind Basic
 * Auth) + same-origin enforced via rejectIfCrossOriginStrict.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  let body: { status?: unknown };
  try {
    body = (await request.json()) as { status?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (typeof body.status !== "string" || !ALLOWED_STATUSES.has(body.status)) {
    return NextResponse.json(
      { error: "status must be one of: paused, running" },
      { status: 400 },
    );
  }

  try {
    const updated = await updateCampaignV2Status(id, body.status);
    console.log(`[campaigns-v2] status updated: campaign=${id} status=${body.status}`);
    return NextResponse.json(updated);
  } catch (err) {
    // .single() throws when the id matches no row (PostgREST PGRST116) as well
    // as on a genuine DB error; the detail page treats any failure as a logged
    // no-op, matching the old anon behaviour.
    console.error("[campaigns-v2] status update failed:", err);
    return NextResponse.json({ error: "Failed to update campaign status" }, { status: 500 });
  }
}
