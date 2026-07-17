import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchSegmentPhones } from "@/lib/customerio";
import { parsePhoneList, nameByE164 } from "@/lib/campaignV2Shared";
import { parseJsonBody } from "@/lib/jsonBody";

// Up to: paginated customer.io fetch (~10-30s for segments <500 at the
// 10 req/sec rate limit), Supabase SELECTs, batched INSERT + UPDATE.
export const maxDuration = 60;

const REFRESHABLE_STATUSES = new Set(["draft", "paused", "inactive", "completed", "archived"]);

/**
 * Outcomes that signal "this phone is currently eligible for dialing." These
 * are the ONLY outcomes that get soft-marked to 'removed_from_segment' when
 * the phone falls out of a refreshed segment. Every other outcome represents
 * permanent historical state (dialed, opted-out, suppressed, etc.) and is
 * preserved per design doc §5.5 step 3.
 *
 * Matches the scheduler's "what to pick up next" filter at
 * src/lib/dialer.ts findNextNumber.
 */
const SOFT_MARKABLE_OUTCOMES = new Set(["pending", "pending_retry"]);

/**
 * POST /api/campaigns-v2/[id]/refresh-segment
 *
 * Re-queries the campaign's customer.io segment and applies a non-destructive
 * diff to the existing campaign_numbers_v2 rows.
 *
 * Differs from Duplicate (Step 5b): no new campaign is created, no clone, no
 * slot lease. The source campaign is modified in place — new segment members
 * become pending rows; existing pending rows that fell out of the segment get
 * soft-marked 'removed_from_segment'; dialed history is untouched.
 *
 * Two-call protocol:
 *   - commit=false (default) returns a preview with the 4-bucket diff
 *     (toAdd / toRemove / preservedPending / preservedDialed) plus a
 *     5-sample peek per bucket
 *   - commit=true applies the diff: INSERT toAdd rows, UPDATE toRemove
 *     outcomes
 *
 * Request body:
 *   { commit?: boolean }
 *
 * Allowed states: {draft, paused, inactive, completed, archived}. The 'running'
 * status is REJECTED with 400 to prevent racing against in-flight dialing
 * (per task tracker §6).
 *
 * Requires source.segment_id to be non-null. Multi-segment imports and
 * pre-Step-5a campaigns have no source segment to refresh against — return
 * 400 with a friendly message.
 *
 * Diff semantics (per design doc §5.5):
 *   For each phone in the refreshed segment:
 *     - Already exists in campaign_numbers_v2 → preserve (no change)
 *     - Not in campaign_numbers_v2 → INSERT with outcome='pending' (toAdd)
 *   For each phone in campaign_numbers_v2 NOT in the refreshed segment:
 *     - outcome IN {pending, pending_retry} → UPDATE outcome='removed_from_segment' (toRemove)
 *     - any other outcome (dialed history) → preserve untouched
 *
 * Concurrency note: this endpoint is not transactional across the INSERT and
 * UPDATE; if a concurrent dial fires between the two, the eligibility set
 * the dialer sees is a momentary mix. For PoC scale (operator-driven, low
 * frequency), this is acceptable. The status whitelist prevents the more
 * dangerous race against a `running` campaign.
 *
 * Design: docs/2026-05-15_DOC_Dashboard_Rebuild_Design.md §5.5
 * Task:   .agent/tasks/2026-05-15_TASK_Dashboard_Rebuild_Phase_1.md §6
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

  // ── Body parse ──
  let commit = false;
  try {
    const body = (await parseJsonBody(request)) as { commit?: unknown };
    commit = body.commit === true;
  } catch {
    // Body is optional; preview is the safe default.
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

  if (!REFRESHABLE_STATUSES.has(source.status as string)) {
    return NextResponse.json(
      {
        error:
          source.status === "running"
            ? "Cannot refresh a running campaign's segment. Pause it first."
            : `Cannot refresh a ${source.status} campaign's segment.`,
      },
      { status: 400 },
    );
  }

  if (source.segment_id == null) {
    return NextResponse.json(
      {
        error:
          "This campaign has no source segment to refresh from " +
          "(multi-segment import or pre-Step-5a campaign). " +
          "No-op.",
      },
      { status: 400 },
    );
  }

  // ── 2. Fetch the current segment members from customer.io ──
  const segmentResult = await fetchSegmentPhones(source.segment_id as number);
  if (!segmentResult.ok) {
    return NextResponse.json(
      { error: `Customer.io fetch failed: ${segmentResult.error}` },
      { status: segmentResult.status },
    );
  }

  // parsePhoneList normalizes to E.164 + dedupes (matches the create-flow's
  // canonicalization, so the diff lines up against existing campaign_numbers_v2
  // rows that were inserted from the same parsePhoneList pipeline).
  const segmentPhones = parsePhoneList(segmentResult.phones.join("\n"));
  const segmentPhonesSet = new Set(segmentPhones);
  // Greet-by-name Ramp 1: names ride the same profile fetch, keyed by the
  // normalized phone so they line up with the rows inserted below.
  const namesByPhone = nameByE164(segmentResult.entries);

  // ── 3. Read the source's existing campaign_numbers_v2 rows ──
  const { data: existingRows, error: existingErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("phone_e164, outcome")
    .eq("campaign_id", id);

  if (existingErr) {
    return NextResponse.json({ error: "Failed to read existing numbers" }, { status: 500 });
  }

  const existingByPhone = new Map<string, string>();
  for (const r of existingRows ?? []) {
    existingByPhone.set(r.phone_e164 as string, r.outcome as string);
  }

  // ── 4. Compute the 4-bucket diff ──
  //
  // toAdd               : in segment, NOT in existing → INSERT as pending
  // preservedPending    : in both, existing outcome IN soft-markable → no-op
  // preservedDialed     : in both, existing outcome NOT soft-markable → no-op
  // toRemove            : in existing (soft-markable outcome), NOT in segment
  // preservedDialedOOS  : in existing (dialed outcome), NOT in segment → preserved
  //                       (kept as a count for the response; not actioned)
  const toAdd: string[] = [];
  const preservedPending: string[] = [];
  const preservedDialedInSegment: string[] = [];
  const toRemove: string[] = [];
  const preservedDialedOOS: string[] = [];

  for (const phone of segmentPhones) {
    const existing = existingByPhone.get(phone);
    if (existing === undefined) {
      toAdd.push(phone);
    } else if (SOFT_MARKABLE_OUTCOMES.has(existing)) {
      preservedPending.push(phone);
    } else {
      preservedDialedInSegment.push(phone);
    }
  }

  for (const [phone, outcome] of existingByPhone.entries()) {
    if (segmentPhonesSet.has(phone)) continue; // covered above
    if (SOFT_MARKABLE_OUTCOMES.has(outcome)) {
      toRemove.push(phone);
    } else {
      preservedDialedOOS.push(phone);
    }
  }

  const sample = (arr: string[]) => arr.slice(0, 5);

  // ── 5. Preview ──
  if (!commit) {
    return NextResponse.json({
      preview: true,
      campaignId: id,
      campaignName: source.name,
      segmentId: source.segment_id,
      segmentMembersCount: segmentPhones.length,
      existingRowsCount: existingByPhone.size,
      toAdd: { count: toAdd.length, sample: sample(toAdd) },
      toRemove: { count: toRemove.length, sample: sample(toRemove) },
      preservedPending: { count: preservedPending.length },
      preservedDialed: {
        inSegment: preservedDialedInSegment.length,
        outOfSegment: preservedDialedOOS.length,
        total: preservedDialedInSegment.length + preservedDialedOOS.length,
      },
    });
  }

  // ── 6. Commit: INSERT new rows + UPDATE soft-marked rows ──
  //
  // Order matters slightly: INSERT first so a concurrent dial (race) sees the
  // expanded eligibility set, then UPDATE to soft-mark removed phones. If
  // either fails partway, the campaign sits in a consistent-but-stale state
  // (some changes applied, others not). The status whitelist already rejects
  // 'running', which is the only state where a race-against-dialer matters.

  let insertedCount = 0;
  if (toAdd.length > 0) {
    const insertRows = toAdd.map((phone) => ({
      campaign_id: id,
      phone_e164: phone,
      outcome: "pending" as const,
      display_name: namesByPhone.get(phone) ?? null,
    }));
    const { error: insertErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .insert(insertRows);
    if (insertErr) {
      console.error(`[campaigns-v2/refresh-segment] INSERT failed:`, insertErr);
      return NextResponse.json(
        {
          error: "Failed to insert new segment members. No changes applied.",
          committed: false,
        },
        { status: 500 },
      );
    }
    insertedCount = toAdd.length;
  }

  let softMarkedCount = 0;
  if (toRemove.length > 0) {
    // PostgREST .in() practical limit is ~1000. PoC scale is well under;
    // batch in chunks of 500 if a future deployment grows segments.
    const { error: updateErr, count } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "removed_from_segment" }, { count: "exact" })
      .eq("campaign_id", id)
      .in("outcome", Array.from(SOFT_MARKABLE_OUTCOMES))
      .in("phone_e164", toRemove);
    if (updateErr) {
      console.error(`[campaigns-v2/refresh-segment] UPDATE failed:`, updateErr);
      // Partial state: INSERTs succeeded, UPDATE failed. Operator can re-run
      // refresh — INSERTs are idempotent (no-op on second run because the
      // toAdd set will be empty), UPDATE will retry.
      return NextResponse.json(
        {
          error:
            "Inserts applied but soft-mark UPDATE failed. " +
            "Re-run refresh to complete.",
          committed: true,
          partial: true,
          insertedCount,
        },
        { status: 500 },
      );
    }
    softMarkedCount = count ?? toRemove.length;
  }

  // ── 7. Audit log ──
  console.log(
    `[campaigns-v2/refresh-segment] audit ` +
    JSON.stringify({
      campaignId: id,
      campaignName: source.name,
      segmentId: source.segment_id,
      segmentMembersCount: segmentPhones.length,
      existingRowsCount: existingByPhone.size,
      insertedCount,
      softMarkedCount,
      preservedPendingCount: preservedPending.length,
      preservedDialedTotal: preservedDialedInSegment.length + preservedDialedOOS.length,
      timestamp: new Date().toISOString(),
    }),
  );

  return NextResponse.json({
    committed: true,
    campaignId: id,
    campaignName: source.name,
    segmentId: source.segment_id,
    segmentMembersCount: segmentPhones.length,
    insertedCount,
    softMarkedCount,
    preservedPendingCount: preservedPending.length,
    preservedDialedCount: preservedDialedInSegment.length + preservedDialedOOS.length,
  });
}
