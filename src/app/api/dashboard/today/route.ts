import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  buildCandidateDelta,
  computeTodayFromRollup,
  type CallRollupRow,
  type CandidateCallRow,
  type DashCampaignRow,
  type SmsRollupRow,
} from "@/lib/dashboardAnalytics";
import { substantiveUserTurnCount } from "@/lib/transcriptClassify";

/**
 * GET /api/dashboard/today
 *
 * Always-live "Today's Performance" snapshot (Val's spec, 2026-06-15) — this is
 * the section that is NEVER touched by the global filters.
 *
 * VOZ-283 (2026-08-04): aggregation moved to the dashboard_call_rollup /
 * dashboard_sms_rollup Postgres functions. The old path paged EVERY calls_v2
 * row of the 10-day window (incl. transcripts) through JS — the 08-02/03
 * incident made that ~47k rows / 48 pages / ~16MB per dashboard load. Now:
 * two RPCs + ONE small fetch of transcript-candidate calls (the single bucket
 * SQL cannot classify: isEarlyHangup's "customer-ended-call with ≤1
 * substantive turn", which the lean rollup files under neutral). Byte-parity
 * with computeToday is proven by src/lib/dashboardRollup.parity.test.ts on
 * live prod data; the response JSON shape is unchanged.
 *
 * The candidate SQL predicate below MUST stay in lockstep with the JS
 * predicate in that parity test.
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
  // 10 days back covers today + yesterday + each day's prior-7-day average window.
  const cutoff = new Date(now - 10 * MS_PER_DAY).toISOString();
  const nowIso = new Date(now).toISOString();
  const todayStartMs = Date.UTC(
    new Date(now).getUTCFullYear(), new Date(now).getUTCMonth(), new Date(now).getUTCDate(),
  );

  const [callRollupRes, smsRollupRes, campaignsRes] = await Promise.all([
    supabaseAdmin.rpc("dashboard_call_rollup", { p_start: cutoff, p_end: nowIso }),
    supabaseAdmin.rpc("dashboard_sms_rollup", { p_start: cutoff, p_end: nowIso }),
    supabaseAdmin
      .from("campaigns_v2")
      // cio_workspace: the brand chip + panel brand-scope line (VOZ-216).
      .select("id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at"),
  ]);

  if (callRollupRes.error || smsRollupRes.error || campaignsRes.error) {
    console.error(
      "[dashboard/today] query failed:",
      callRollupRes.error ?? smsRollupRes.error ?? campaignsRes.error,
    );
    return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
  }
  const campaignRows = (campaignsRes.data ?? []) as unknown as DashCampaignRow[];

  // ── Transcript-candidate fetch (the ONE bucket SQL can't classify) ──
  // Keyset-paged: candidates are typically dozens-to-hundreds over 10 days, but
  // never trust a bare select's 1000-row clamp. Predicate mirrors the parity
  // test: connected, non-voicemail, non-goal, customer-ended, not lean-early.
  type RawCandidate = CandidateCallRow & { campaign_number_id: string | null };
  const candidatesRaw: RawCandidate[] = [];
  {
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("calls_v2")
        .select("id, campaign_id, campaign_number_id, created_at, transcript")
        .gte("created_at", cutoff)
        .in("status", ["completed", "answered"])
        .not("voicemail", "is", true)
        .not("goal_reached", "is", true)
        .eq("ended_reason", "customer-ended-call")
        .or("duration_seconds.is.null,duration_seconds.gte.15")
        .order("id", { ascending: true })
        .gt("id", lastId)
        .limit(1000);
      if (error) {
        console.error("[dashboard/today] candidate query failed:", error);
        return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
      }
      candidatesRaw.push(...((data ?? []) as unknown as RawCandidate[]));
      if (!data || data.length < 1000) break;
      lastId = (data[data.length - 1] as { id: string }).id;
    }
  }

  // Ghost/test exclusion (rollups exclude in SQL; candidates must match).
  const campIndex = new Map(campaignRows.map((c) => [c.id, c]));
  const liveCandidates = candidatesRaw.filter((c) => {
    const camp = campIndex.get(c.campaign_id);
    return camp && camp.source !== "ghost_portal" && camp.is_test !== true;
  });

  // Declined-contact exclusion (chunked .in() — URL size limit, see old route).
  const IN_CHUNK = 150;
  const contactIds = [...new Set(liveCandidates.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  const declinedIds = new Set<string>();
  for (let i = 0; i < contactIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, outcome")
      .in("id", contactIds.slice(i, i + IN_CHUNK));
    if (error) {
      console.error("[dashboard/today] candidate contact query failed:", error);
      return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
    }
    for (const n of data ?? []) {
      if ((n.outcome ?? "") === "declined_offer") declinedIds.add(n.id as string);
    }
  }
  const candidates = liveCandidates.filter(
    (c) => !(c.campaign_number_id && declinedIds.has(c.campaign_number_id)),
  );

  // SMS attached to candidate calls (drives the SMS neutral shift). Chunked .in().
  const candidateIds = candidates.map((c) => c.id).filter((x): x is string => !!x);
  const smsAttachments: Array<{ call_id: string | null; created_at: string | null }> = [];
  for (let i = 0; i < candidateIds.length; i += IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("sms_messages_v2")
      .select("call_id, created_at, status")
      .in("call_id", candidateIds.slice(i, i + IN_CHUNK))
      .in("status", ["sent", "delivered"])
      .gte("created_at", cutoff);
    if (error) {
      console.error("[dashboard/today] candidate sms query failed:", error);
      return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
    }
    smsAttachments.push(...((data ?? []) as Array<{ call_id: string | null; created_at: string | null }>));
  }

  const delta = buildCandidateDelta(candidates, smsAttachments, todayStartMs, substantiveUserTurnCount);

  // Roster size (total contacts) per RUNNING campaign — for the "N players" chip.
  const runningIds = campaignRows
    .filter((c) => c.source !== "ghost_portal" && c.is_test !== true && c.status === "running")
    .map((c) => c.id);
  const rosterByCampaign = new Map<string, number>();
  for (const id of runningIds) {
    const { count, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id", { count: "exact", head: true })
      .eq("campaign_id", id);
    if (error) {
      console.error("[dashboard/today] roster count failed:", id, error);
      continue;
    }
    rosterByCampaign.set(id, count ?? 0);
  }

  const snapshot = computeTodayFromRollup(
    (callRollupRes.data ?? []) as CallRollupRow[],
    (smsRollupRes.data ?? []) as SmsRollupRow[],
    campaignRows,
    now,
    delta,
    rosterByCampaign,
  );

  return NextResponse.json(snapshot);
}
