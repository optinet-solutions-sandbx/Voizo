import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList } from "@/lib/campaignV2Shared";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";
import { fetchAllRows, fetchRowsIn } from "@/lib/supabaseFetchAll";
import { MAX_CANDIDATES } from "@/lib/audienceLimits";

// Up to: paginated customer.io segment fetch (for the out-of-segment bucket
// when segment_id is non-null). 60s budget mirrors duplicate/refresh-segment.
export const maxDuration = 60;

const RESUMABLE_STATUSES = new Set(["inactive", "paused"]);
const RECENT_CALL_WINDOW_DAYS = 7;

/**
 * GET /api/campaigns-v2/[id]/resume-diff
 *
 * Computes the three resume-protection buckets against this campaign's own
 * pending phones (outcome IN 'pending' or 'pending_retry'):
 *
 *   1. suppressed:        pending phones that now appear in suppression_list
 *                         or do_not_call (informational; dialer.ts already
 *                         skips them at dial time regardless of the operator's
 *                         skip choice)
 *   2. recentlyCalled:    pending phones that another campaign has dialed in
 *                         the last 7 days (cross-campaign double-dial guard)
 *   3. outOfSegment:      pending phones that are no longer in the customer.io
 *                         segment this campaign was created from (stale-
 *                         eligibility guard). Only computed if segment_id is
 *                         non-null; multi-segment / pre-Step-5a campaigns
 *                         skip this bucket with note='no source segment'.
 *
 * No side effects — pure read. Soft-marking happens in POST /resume after
 * the operator picks a skip strategy.
 *
 * Allowed status: 'inactive' or 'paused'. Both are resumable; the resume
 * endpoint branches on which (inactive → rebind, paused → simple status flip).
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.7
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §7
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // ── Optional origin check (read-only endpoint, GETs often lack Origin) ──
  // Browsers omit the Origin header on same-origin GET requests in some
  // contexts (e.g., devtools console fetch, simple navigation-style GETs).
  // OWASP guidance: CSRF protection applies to state-changing requests, not
  // read-only ones. So if Origin IS present we enforce exact-host match
  // (defense in depth), but missing Origin on a GET is allowed.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      const originUrl = new URL(origin);
      if (originUrl.host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid campaign ID" }, { status: 400 });
  }

  // ── 1. Read source campaign ──
  const { data: source, error: selectErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status, segment_id, cio_workspace")
    .eq("id", id)
    .single();

  if (selectErr || !source) {
    return NextResponse.json({ error: "Campaign not found" }, { status: 404 });
  }

  if (!RESUMABLE_STATUSES.has(source.status as string)) {
    return NextResponse.json(
      {
        error: `Cannot compute resume-diff for a ${source.status} campaign. Only inactive and paused campaigns are resumable.`,
      },
      { status: 400 },
    );
  }

  // ── 2. Read source's pending phones (paged — VOZ-266) ──
  // The bare select this replaces was clamped by PostgREST max-rows at 1000
  // rows, which BLINDED the size guard below (the read could never return
  // more than 1000, so the 413 was dead code) and fed a 1,000-phone .in()
  // to the bucket queries — which throws UND_ERR_HEADERS_OVERFLOW inside our
  // HTTP client (measured 2026-07-30), leaving every safety bucket silently
  // empty on large campaigns. failFast: a partial phone list = wrong diff.
  let pendingPhones: string[];
  try {
    const pendingRows = await fetchAllRows(
      supabaseAdmin, "campaign_numbers_v2", "phone_e164", "id",
      { column: "campaign_id", value: id },
      undefined, undefined,
      { failFast: true, inFilter: { column: "outcome", values: ["pending", "pending_retry"] } },
    );
    pendingPhones = pendingRows.map((r) => r.phone_e164 as string);
  } catch (err) {
    console.error(`[campaigns-v2/resume-diff] pending read failed for ${id}:`, err);
    return NextResponse.json({ error: "Failed to read pending numbers" }, { status: 500 });
  }

  // Empty pending → trivially-zero diff (still return the shape so the UI can
  // disable the resume button rather than show a half-loaded modal).
  if (pendingPhones.length === 0) {
    return NextResponse.json({
      campaignId: id,
      campaignName: source.name,
      previousStatus: source.status,
      pendingCount: 0,
      suppressed: { count: 0, sample: [] },
      recentlyCalled: { count: 0, sample: [] },
      outOfSegment: {
        count: 0,
        sample: [],
        ...(source.segment_id == null ? { note: "no source segment" } : {}),
      },
      segmentId: source.segment_id ?? null,
      // Phase 4: all resumes go through executeRebindCore (createClone +
      // leaseSlot + patchPhoneAssistant) — typically 1–3s of latency. The
      // dashboard's Resume modal should surface this to the operator.
      rebindRequired: true,
    });
  }

  // The paged read makes this ceiling REAL again (with the clamp it could
  // never trip). Chunked buckets handle anything under it; the cap is a
  // sanity bound shared with duplicate, not a URL limit anymore.
  if (pendingPhones.length > MAX_CANDIDATES) {
    return NextResponse.json(
      {
        error:
          `Pending set is ${pendingPhones.length} phones; current diff implementation ` +
          `caps at ${MAX_CANDIDATES}. Reach out to engineering to lift the cap.`,
      },
      { status: 413 },
    );
  }

  // ── 3. Compute the suppressed + recentlyCalled buckets (chunked — VOZ-266) ──
  // fetchRowsIn THROWS on any chunk failure. The Promise.all this replaces
  // never checked .error, so a failed .in() (guaranteed at >=1000 phones)
  // reported "0 suppressed, 0 DNC, 0 recently-called" with full confidence.
  // An honest 500 beats a confident lie on a safety surface.
  const recentCutoffIso = new Date(
    Date.now() - RECENT_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  let suppressedSet: Set<string>;
  let recentSet: Set<string>;
  try {
    const [suppressedRows, dncRows, recentRows] = await Promise.all([
      fetchRowsIn(supabaseAdmin, "suppression_list", "phone_e164", "phone_e164", pendingPhones),
      fetchRowsIn(supabaseAdmin, "do_not_call", "phone_number", "phone_number", pendingPhones, (q) =>
        q.eq("archived", false),
      ),
      fetchRowsIn(supabaseAdmin, "campaign_numbers_v2", "phone_e164", "phone_e164", pendingPhones, (q) =>
        q.neq("campaign_id", id).in("outcome", CONTACT_OUTCOMES).gt("last_attempted_at", recentCutoffIso),
      ),
    ]);
    suppressedSet = new Set<string>([
      ...dncRows.map((r) => r.phone_number as string),
      ...suppressedRows.map((r) => r.phone_e164 as string),
    ]);
    recentSet = new Set(recentRows.map((r) => r.phone_e164 as string));
  } catch (err) {
    console.error(`[campaigns-v2/resume-diff] bucket queries failed for ${id}:`, err);
    return NextResponse.json({ error: "Failed to compute safety buckets" }, { status: 500 });
  }

  // ── 4. Compute the outOfSegment bucket (only if segment_id non-null) ──
  const outOfSegmentSet = new Set<string>();
  let outOfSegmentNote: string | undefined;
  let segmentSnapshotSize: number | undefined;

  if (source.segment_id != null) {
    const segmentResult = await fetchSegmentPhones(
      source.segment_id as number,
      source.cio_workspace as string | null, // VOZ-198: fetch with THIS campaign's workspace key
    );
    if (!segmentResult.ok) {
      return NextResponse.json(
        { error: `Customer.io fetch failed: ${segmentResult.error}` },
        { status: segmentResult.status },
      );
    }
    // Normalize to E.164 + dedupe (matches the create-flow canonicalization,
    // so the diff lines up against pending phones that were inserted via the
    // same parsePhoneList pipeline).
    const segmentPhones = parsePhoneList(segmentResult.phones.join("\n"));
    const segmentSet = new Set(segmentPhones);
    segmentSnapshotSize = segmentSet.size;

    // Pending phones that the fresh segment no longer contains.
    for (const phone of pendingPhones) {
      if (!segmentSet.has(phone)) outOfSegmentSet.add(phone);
    }
  } else {
    outOfSegmentNote = "no source segment";
  }

  const sample = (s: Set<string>) => Array.from(s).slice(0, 5);

  return NextResponse.json({
    campaignId: id,
    campaignName: source.name,
    previousStatus: source.status,
    pendingCount: pendingPhones.length,
    suppressed: { count: suppressedSet.size, sample: sample(suppressedSet) },
    recentlyCalled: { count: recentSet.size, sample: sample(recentSet) },
    outOfSegment: {
      count: outOfSegmentSet.size,
      sample: sample(outOfSegmentSet),
      ...(segmentSnapshotSize !== undefined ? { segmentSnapshotSize } : {}),
      ...(outOfSegmentNote ? { note: outOfSegmentNote } : {}),
    },
    segmentId: source.segment_id ?? null,
    // Phase 4: all resumes go through executeRebindCore (createClone +
    // leaseSlot + patchPhoneAssistant) — typically 1–3s of latency. The
    // dashboard's Resume modal should surface this to the operator.
    rebindRequired: true,
  });
}
