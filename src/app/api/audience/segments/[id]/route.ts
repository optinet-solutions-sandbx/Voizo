import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";

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

function rejectIfCrossOrigin(request: NextRequest): NextResponse | null {
  // Lenient: GETs allow missing Origin per feedback_csrf_origin_check_get_lenient.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) return null;
  try {
    if (new URL(origin).host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }
  return null;
}

function rejectIfCrossOriginStrict(request: NextRequest): NextResponse | null {
  // Strict: DELETE is state-changing — Origin must be present and match host.
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (!origin || !host) {
    return NextResponse.json({ error: "Forbidden — missing origin" }, { status: 403 });
  }
  try {
    if (new URL(origin).host !== host) {
      return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
    }
  } catch {
    return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
  }
  return null;
}

// ── GET ───────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;

  const { id } = await params;
  if (!id || typeof id !== "string" || id.length > 40) {
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
  if (!id || typeof id !== "string" || id.length > 40) {
    return NextResponse.json({ error: "Invalid segment ID" }, { status: 400 });
  }

  // FK on local_segment_numbers has ON DELETE CASCADE — no manual cleanup.
  const { error, count } = await supabaseAdmin
    .from("local_segments")
    .delete({ count: "exact" })
    .eq("id", id);

  if (error) {
    return NextResponse.json(
      { error: `Failed to delete segment: ${error.message}` },
      { status: 500 },
    );
  }

  if (!count) {
    return NextResponse.json({ error: "Segment not found" }, { status: 404 });
  }

  console.log(`[audience] segment deleted: id=${id}`);
  return NextResponse.json({ deleted: true, id });
}
