import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { rejectIfCrossOrigin, rejectIfCrossOriginStrict } from "@/lib/csrf";

/**
 * /api/audience/segments/[id]
 *
 *   GET    — segment detail + first N numbers (cursor pagination on created_at + id)
 *   DELETE — drop segment (cascade removes local_segment_numbers via FK)
 *
 * Plan: .claude/plans/new-shift-picking-gentle-puffin.md Slice 1.
 */

const DEFAULT_PAGE_SIZE = 100;
const MAX_PAGE_SIZE = 500;

// Strict UUID v1-5 shape. Mirrors the regex in /api/campaigns-v2/[id]/is-test
// (A6, 2026-05-22). Replaces the prior lenient `id.length > 40` check that
// accepted any 36-char string. Operator gets "Invalid segment ID" instead
// of PostgREST's "invalid input syntax for type uuid".
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ── GET ───────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid segment ID" }, { status: 400 });
  }

  const url = new URL(request.url);
  const limit = Math.min(
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "", 10) || DEFAULT_PAGE_SIZE),
    MAX_PAGE_SIZE,
  );
  const cursor = url.searchParams.get("cursor"); // last_id from previous page

  // ── 1. Segment row ──
  const { data: segment, error: segErr } = await supabaseAdmin
    .from("local_segments")
    .select(
      "id, name, source_campaign_id, source_campaign_name, outcomes_included, dnc_scrubbed, recent_window_days, total_count, scrubbed_count, created_at, created_by",
    )
    .eq("id", id)
    .single();

  if (segErr || !segment) {
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }

  // ── 2. Numbers page ──
  let q = supabaseAdmin
    .from("local_segment_numbers")
    .select("id, phone_e164, source_outcome, source_attempts, created_at")
    .eq("segment_id", id)
    .order("id", { ascending: true })
    .limit(limit + 1); // +1 to detect "has more"

  if (cursor) q = q.gt("id", cursor);

  const { data: numbers, error: numErr } = await q;

  if (numErr) {
    return NextResponse.json(
      { error: `Failed to read segment numbers: ${numErr.message}` },
      { status: 500 },
    );
  }

  const rows = numbers ?? [];
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const nextCursor = hasMore ? (page[page.length - 1]?.id as string) : null;

  return NextResponse.json({
    segment,
    numbers: page,
    pagination: { limit, nextCursor, hasMore },
  });
}

// ── DELETE ────────────────────────────────────────────────────────────────

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || !UUID_RE.test(id)) {
    return NextResponse.json({ error: "Invalid segment ID" }, { status: 400 });
  }

  // Snapshot the source_campaign_id + phones BEFORE deletion so we can
  // un-soft-mark the source rows afterward. The POST handler flips source
  // campaign_numbers_v2 rows from pending/pending_retry to
  // 'removed_from_segment' when a segment is created (double-dial guard).
  // Without this restore step, deleting the segment leaves those source
  // rows orphaned — they can't be re-dialed by the source AND can't be
  // recycled into a new segment. Discovered in prod 2026-05-22.
  const { data: segment, error: segErr } = await supabaseAdmin
    .from("local_segments")
    .select("source_campaign_id")
    .eq("id", id)
    .single();

  if (segErr || !segment) {
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }

  const { data: numbers, error: numErr } = await supabaseAdmin
    .from("local_segment_numbers")
    .select("phone_e164")
    .eq("segment_id", id);

  if (numErr) {
    // Non-fatal — log + proceed with delete. Without phones, we can't
    // un-soft-mark, so the operator may need to restore manually (rare).
    console.warn(
      `[audience] segment ${id} delete: could not read numbers before delete: ${numErr.message}`,
    );
  }

  // FK on local_segment_numbers has ON DELETE CASCADE — no manual cleanup.
  const { error: delErr, count } = await supabaseAdmin
    .from("local_segments")
    .delete({ count: "exact" })
    .eq("id", id);

  if (delErr) {
    return NextResponse.json(
      { error: `Failed to delete segment: ${delErr.message}` },
      { status: 500 },
    );
  }

  if (!count) {
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }

  // Un-soft-mark source rows: flip outcome from 'removed_from_segment' back
  // to 'pending'. Filter on outcome='removed_from_segment' so we never stomp
  // newer terminal outcomes (e.g. source paused then resumed then dialed).
  let restoredCount = 0;
  const phones = (numbers ?? []).map((n) => n.phone_e164 as string);
  if (phones.length > 0) {
    const { data: restored, error: restErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "pending" })
      .eq("campaign_id", segment.source_campaign_id as string)
      .in("phone_e164", phones)
      .eq("outcome", "removed_from_segment")
      .select("id");

    if (restErr) {
      console.warn(
        `[audience] segment ${id} deleted but un-soft-mark failed for source ` +
          `${segment.source_campaign_id}: ${restErr.message}`,
      );
    } else {
      restoredCount = restored?.length ?? 0;
    }
  }

  console.log(`[audience] segment deleted: id=${id} restored=${restoredCount}`);
  return NextResponse.json({ deleted: true, id, restored: restoredCount });
}
