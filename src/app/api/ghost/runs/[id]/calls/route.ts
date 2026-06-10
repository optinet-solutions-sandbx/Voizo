import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../../../lib/supabaseServer";
import { rejectIfCrossOrigin } from "../../../../../../lib/csrf";
import { ghostPortalEnabled } from "../../../../../../lib/ghost/ghostConfig";
import { getGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { listGhostRunCalls } from "../../../../../../lib/ghost/ghostLabelData";

/**
 * GET /api/ghost/runs/[id]/calls — the run's labelable calls (real conversations)
 * for the per-run review panel on /s/[slug], joined with the operator's existing
 * ghost labels. Flag-gated (404 when off), behind Basic Auth, read-only (lenient
 * CSRF). Empty list until the run is launched (no materialized campaign yet).
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;
  const run = await getGhostRun(supabaseAdmin, id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });
  if (!run.campaign_id) return NextResponse.json({ calls: [] }); // not launched yet

  const operator = process.env.DASHBOARD_USERNAME ?? "operator";
  const calls = await listGhostRunCalls(supabaseAdmin, run.campaign_id, operator);
  return NextResponse.json({ calls });
}
