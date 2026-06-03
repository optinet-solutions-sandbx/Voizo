import { NextRequest, NextResponse } from "next/server";
import { snapshotCampaignPrompt } from "@/lib/promptVersionData";

// Re-reads the campaign's clone from Vapi (1 GET) + one upsert. 30s mirrors the
// other Vapi-touching campaign routes (rebind/eject/stop).
export const maxDuration = 30;

/**
 * POST /api/campaigns-v2/[id]/snapshot-prompt
 *
 * Records an immutable prompt_versions snapshot of the effective system prompt a
 * campaign's cloned Vapi assistant ran with — the keystone of the eval loop
 * ("did v7 beat v6?"). Slice 2 of the Agent training/eval surface.
 *
 * This is the MANUAL-create entry point: the create wizard fires it
 * (fire-and-forget) after createCampaignV2 returns, since createCampaignV2 runs
 * client-side via the anon client and cannot write to a default-deny RLS table.
 * The rebind/resume and recurring-spawn paths call snapshotCampaignPrompt()
 * directly server-side (no HTTP hop). All writes use the service role.
 *
 * BEST-EFFORT: a snapshot is observability, never a correctness gate. Any
 * internal failure (no clone, Vapi down, DB error) returns 200 with
 * {ok:false, skipped:<reason>} so the fire-and-forget caller can ignore it.
 * Only security (origin) and validation (id) failures return non-200.
 *
 * Guards mirror the sibling rebind route: URL-parsed exact host-equality origin
 * check; campaign id length-bounded. No request body.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Origin check (URL-parsed exact host equality — matches rebind/eject/stop) ──
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
  // Strict UUID (matches slice-1 /api/reviews/label). A malformed id is a clean
  // 400 at the edge rather than reaching the service-role DB layer and surfacing
  // as a misleading "db-error" skip.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  // Delegate to the best-effort writer. It never throws; the tagged result is
  // returned as-is at 200 so the wizard's fire-and-forget call can ignore it.
  const result = await snapshotCampaignPrompt(id);
  return NextResponse.json(result, { status: 200 });
}
