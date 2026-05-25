import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList } from "@/lib/campaignV2Data";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";

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
    .select("id, name, status, segment_id")
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

  // ── 2. Read source's pending phones ──
  const { data: pendingRows, error: pendingErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("phone_e164")
    .eq("campaign_id", id)
    .in("outcome", ["pending", "pending_retry"]);

  if (pendingErr) {
    return NextResponse.json({ error: "Failed to read pending numbers" }, { status: 500 });
  }

  const pendingPhones = (pendingRows ?? []).map((r) => r.phone_e164 as string);

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
    });
  }

  // PostgREST .in() practical limit ~1000 items. PoC scale is well under.
  if (pendingPhones.length > 1000) {
    return NextResponse.json(
      {
        error:
          `Pending set is ${pendingPhones.length} phones; current diff implementation ` +
          `caps at 1000. Reach out to engineering to lift the cap.`,
      },
      { status: 413 },
    );
  }

  // ── 3. Compute the suppressed + recentlyCalled buckets (parallel queries) ──
  const recentCutoffIso = new Date(
    Date.now() - RECENT_CALL_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [suppressedRes, dncRes, recentRes] = await Promise.all([
    supabaseAdmin
      .from("suppression_list")
      .select("phone_e164")
      .in("phone_e164", pendingPhones),
    supabaseAdmin
      .from("do_not_call")
      .select("phone_number")
      .eq("archived", false)
      .in("phone_number", pendingPhones),
    supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .neq("campaign_id", id)
      .in("phone_e164", pendingPhones)
      .in("outcome", CONTACT_OUTCOMES)
      .gt("last_attempted_at", recentCutoffIso),
  ]);

  const suppressedSet = new Set<string>([
    ...((suppressedRes.data ?? []).map((r) => r.phone_e164 as string)),
    ...((dncRes.data ?? []).map((r) => r.phone_number as string)),
  ]);
  const recentSet = new Set((recentRes.data ?? []).map((r) => r.phone_e164 as string));

  // ── 4. Compute the outOfSegment bucket (only if segment_id non-null) ──
  const outOfSegmentSet = new Set<string>();
  let outOfSegmentNote: string | undefined;
  let segmentSnapshotSize: number | undefined;

  if (source.segment_id != null) {
    const segmentResult = await fetchSegmentPhones(source.segment_id as number);
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
  });
}
