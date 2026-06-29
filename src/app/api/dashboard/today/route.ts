import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  computeToday,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
  type DashNumberRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/today
 *
 * Always-live "Today's Performance" snapshot (Val's spec, 2026-06-15) — this is
 * the section that is NEVER touched by the global filters. Ghost (source=
 * 'ghost_portal') and test campaigns are excluded inside computeToday().
 *
 * Definitions (see dashboardAnalytics.ts): connectRate = connected/terminal where
 * connected == 'completed' (ANSWER, incl. voicemail); successRate = goal_reached/connected.
 *
 * Read-only, no side effects. Lenient origin policy (same as /api/dashboard/metrics).
 * Aggregation is JS-side over an 8-day call window — fine at PoC volume; promote to
 * a SQL rollup only if it proves slow.
 */
const MS_PER_DAY = 86_400_000;

export async function GET(request: NextRequest) {
  // Lenient origin check (GET — same policy as /api/dashboard/metrics).
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "Forbidden — cross-origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "Forbidden — invalid origin" }, { status: 403 });
    }
  }

  const now = Date.now();
  // 10 days back covers today + yesterday + each day's prior-7-day average window (the toggle).
  const callsCutoff = new Date(now - 10 * MS_PER_DAY).toISOString();
  // SMS breakdown spans the same 10-day window (per-day rows + 7d-avg baselines).
  const smsCutoff = new Date(now - 10 * MS_PER_DAY).toISOString();

  const [callsRes, campaignsRes, smsRes] = await Promise.all([
    supabaseAdmin
      .from("calls_v2")
      .select("id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds, transcript")
      .gte("created_at", callsCutoff),
    supabaseAdmin
      .from("campaigns_v2")
      .select("id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, start_at, created_at, end_at"),
    supabaseAdmin
      .from("sms_messages_v2")
      .select("campaign_id, created_at, status, call_id, campaign_number_id")
      .gte("created_at", smsCutoff),
  ]);

  if (callsRes.error || campaignsRes.error || smsRes.error) {
    console.error(
      "[dashboard/today] query failed:",
      callsRes.error ?? campaignsRes.error ?? smsRes.error,
    );
    return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
  }

  const calls = (callsRes.data ?? []) as unknown as DashCallRow[];

  // Contacts referenced by the windowed calls — needed for the Reached/SMS "declined" bucket
  // (campaign_numbers_v2.outcome === 'declined_offer'). Scoped to the call set, chunked for safety.
  const numIds = [...new Set(calls.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  // Chunk the .in() so the request URL stays under PostgREST's ~16KB header limit (each UUID is
  // ~37 chars; 150 IDs ≈ 5.5KB). Larger chunks 500 with HeadersOverflowError on busy windows.
  const IN_CHUNK = 150;
  let numbers: DashNumberRow[] = [];
  for (let i = 0; i < numIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, phone_e164, outcome")
      .in("id", numIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error("[dashboard/today] numbers query failed:", error);
      return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
    }
    numbers = numbers.concat((data ?? []) as unknown as DashNumberRow[]);
  }

  const snapshot = computeToday(
    calls,
    (campaignsRes.data ?? []) as unknown as DashCampaignRow[],
    (smsRes.data ?? []) as unknown as DashSmsRow[],
    now,
    numbers,
  );

  return NextResponse.json(snapshot);
}
