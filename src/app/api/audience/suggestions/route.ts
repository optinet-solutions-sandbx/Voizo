import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { rejectIfCrossOrigin } from "@/lib/csrf";

/**
 * GET /api/audience/suggestions
 *
 * Returns the operator-facing worklist for the Audience tab: finished
 * campaigns that still have recyclable phones (pending or pending_retry),
 * eligible for being carved into a local segment.
 *
 * Filtering happens in the Postgres RPC `get_audience_suggestions(...)`
 * (see supabase-migration-rebuild-phase-1h-audience-suggestions-rpc.sql):
 *   - status IN ('paused', 'completed', 'archived', 'inactive')
 *   - is_test = false
 *   - NOT EXISTS in local_segments (dedup: skip sources with existing segments)
 *   - At least p_min_candidates pending/pending_retry phones combined
 *
 * Sorts newest-activity-first (last_dialed_at DESC), LIMIT 20.
 *
 * This endpoint is read-only and side-effect-free. Operator autonomy is
 * preserved: suggestions never trigger soft-marks or any other state change;
 * those happen only when the operator commits via POST /api/audience/segments.
 *
 * Design: docs/2026-05-22_DOC_Audience_Suggestions_MVP.md §5.2
 */

const MIN_CANDIDATES = 5;
const MAX_SUGGESTIONS = 20;

interface SuggestionRow {
  source_campaign_id: string;
  source_campaign_name: string;
  source_status: string;
  // After 1h's ::int cast these arrive as JSON numbers. We still defensively
  // accept string in case PostgREST config drifts (audit 2026-05-22 H4).
  pending_count: number | string;
  pending_retry_count: number | string;
  last_dialed_at: string | null;
}

// Coerce to finite number. Returns 0 on null/undefined/NaN/non-numeric strings.
function safeInt(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

export async function GET(request: NextRequest) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;

  const { data, error } = await supabaseAdmin.rpc("get_audience_suggestions", {
    p_min_candidates: MIN_CANDIDATES,
    p_max_results: MAX_SUGGESTIONS,
  });

  if (error) {
    console.error("[audience/suggestions] RPC error:", error);
    return NextResponse.json(
      { error: `Failed to load suggestions: ${error.message}` },
      { status: 500 },
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const rows = (data ?? []) as SuggestionRow[];

  const suggestions = rows.map((row) => {
    const pending = safeInt(row.pending_count);
    const pendingRetry = safeInt(row.pending_retry_count);
    return {
      source_campaign_id: row.source_campaign_id,
      source_campaign_name: row.source_campaign_name,
      source_status: row.source_status,
      candidates: {
        pending,
        pending_retry: pendingRetry,
        total: pending + pendingRetry,
      },
      last_dialed_at: row.last_dialed_at,
      suggested_defaults: {
        name: `${row.source_campaign_name} — pending recycle (${today})`,
        outcomes_included: ["pending", "pending_retry"],
        dnc_scrubbed: true,
        recent_window_days: 7,
      },
    };
  });

  return NextResponse.json({
    fetched_at: new Date().toISOString(),
    suggestions,
  });
}
