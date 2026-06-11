import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../../../../../lib/supabaseServer";
import { rejectIfCrossOriginStrict } from "../../../../../../../../lib/csrf";
import { ghostPortalEnabled } from "../../../../../../../../lib/ghost/ghostConfig";
import { getGhostRun } from "../../../../../../../../lib/ghost/ghostRunData";
import { callBelongsToCampaign, upsertGhostLabel, type GhostVerdict } from "../../../../../../../../lib/ghost/ghostLabelData";

/**
 * POST /api/ghost/runs/[id]/calls/[callId]/label — upsert THIS operator's manual
 * verdict (good|bad|unsure + reason) for a call belonging to the run's campaign.
 * Flag-gated (404), Basic Auth, strict CSRF. Run-scoped guard: a call that isn't
 * in this run's campaign returns 404 (never reveals it exists elsewhere). Writes
 * to ghost_call_labels only — isolated from call_labels + the AI judge.
 */
const VERDICTS = new Set<GhostVerdict>(["good", "bad", "unsure"]);

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; callId: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id, callId } = await params;

  let body: { verdict?: unknown; reason?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const verdict = VERDICTS.has(body.verdict as GhostVerdict) ? (body.verdict as GhostVerdict) : null;
  if (!verdict) {
    return NextResponse.json({ error: "verdict must be one of good|bad|unsure" }, { status: 400 });
  }

  const run = await getGhostRun(supabaseAdmin, id);
  if (!run || !run.campaign_id) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  // Run-scoped guard: a label may only target a call in THIS run's campaign.
  if (!(await callBelongsToCampaign(supabaseAdmin, callId, run.campaign_id))) {
    return NextResponse.json({ error: "Call not found in this run" }, { status: 404 });
  }

  const operator = process.env.DASHBOARD_USERNAME ?? "operator";
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 2000) : null;
  const label = await upsertGhostLabel(supabaseAdmin, { callId, labeledBy: operator, verdict, reason });
  return NextResponse.json({ label });
}
