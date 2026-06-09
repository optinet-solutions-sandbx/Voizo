import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "../../../../../../lib/supabaseServer";
import { rejectIfCrossOriginStrict } from "../../../../../../lib/csrf";
import { ghostPortalEnabled } from "../../../../../../lib/ghost/ghostConfig";
import { getGhostRun, updateGhostRun } from "../../../../../../lib/ghost/ghostRunData";
import { scrubGhostPhones } from "../../../../../../lib/ghost/ghostScrub";

/**
 * POST /api/ghost/runs/[id]/scrub — preview the DNC/compliance scrub for a run's
 * uploaded phones and persist the audit counts (status -> 'ready').
 *
 * The phone list comes from the client (manual upload; ghost_runs stores no PII).
 * DNC is applied in BOTH tiers; recency only for 'live' (test relaxes it). This is
 * a PREVIEW — launch RE-SCRUBS server-side and never trusts these counts.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;
  if (!ghostPortalEnabled()) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const { id } = await params;

  let body: { phones?: unknown };
  try {
    body = (await request.json()) as { phones?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const phones = Array.isArray(body.phones)
    ? body.phones.filter((p): p is string => typeof p === "string")
    : [];
  if (phones.length === 0) {
    return NextResponse.json({ error: "phones (non-empty array) is required" }, { status: 400 });
  }

  const run = await getGhostRun(supabaseAdmin, id);
  if (!run) return NextResponse.json({ error: "Run not found" }, { status: 404 });

  const result = await scrubGhostPhones(supabaseAdmin, phones, { applyRecency: run.tier === "live" });

  await updateGhostRun(supabaseAdmin, id, {
    status: "ready",
    scrubbed_count: result.net.length,
    suppressed_count: result.suppressed,
  });

  console.log(
    `[ghost] scrub run=${id} tier=${run.tier} uploaded=${result.uploaded} ` +
      `net=${result.net.length} dnc=${result.suppressedDnc} recent=${result.suppressedRecent}`,
  );

  return NextResponse.json({
    uploaded: result.uploaded,
    suppressed: result.suppressed,
    net: result.net.length,
    suppressedDnc: result.suppressedDnc,
    suppressedRecent: result.suppressedRecent,
  });
}
