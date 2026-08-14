import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  buildCandidateDelta,
  computeTodayFromRollup,
  type CallRollupRow,
  type CandidateCallRow,
  type DashCampaignRow,
  type SmsRollupRow,
} from "@/lib/dashboardAnalytics";
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
 * two RPCs + ONE fetch of transcript-candidate calls.
 *
 * VOZ-387 (2026-08-14): the candidate set widened from "customer-ended ≥15s"
 * (the one bucket the old scalar delta could correct) to EVERY connected,
 * non-voicemail, non-goal call — silent_pickup shipped 08-13 and needs turn
 * counts the SQL does not have, so the card showed Reached 376 where the
 * classifier said 110. Cost: ~350-400 transcript rows/day × 10 days ≈ 3-4k
 * rows per load — still ~10x below the pre-rollup 47k that forced VOZ-283.
 * Byte-parity with computeToday is proven by dashboardRollup.parity.test.ts
 * (RUN_PARITY=1, live prod — a MANUAL gate: re-run it whenever this predicate,
 * buildCandidateDelta, or the deployed rollup SQL changes; last verified
 * 2026-08-14). The response JSON shape is unchanged.
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

  const [callRollupRes, smsRollupRes, campaignRowsRaw] = await Promise.all([
    supabaseAdmin.rpc("dashboard_call_rollup", { p_start: cutoff, p_end: nowIso }),
    supabaseAdmin.rpc("dashboard_sms_rollup", { p_start: cutoff, p_end: nowIso }),
    // fetchAllRows pages past PostgREST's 1000-row cap. campaigns_v2 grows daily
    // (recurring day-children); a bare .select() clamps at 1000 with NO stable
    // order, so the kept rows would be arbitrary — running cards could vanish
    // and candidate calls of unlisted campaigns would be silently dropped.
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      // cio_workspace: the brand chip + panel brand-scope line (VOZ-216).
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at",
      "id",
    ),
  ]);

  if (callRollupRes.error || smsRollupRes.error) {
    console.error(
      "[dashboard/today] query failed:",
      callRollupRes.error ?? smsRollupRes.error,
    );
    return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
  }
  const campaignRows = campaignRowsRaw as unknown as DashCampaignRow[];

  // ── Transcript-candidate fetch (every bucket the transcript can change) ──
  // Keyset-paged: never trust a bare select's 1000-row clamp. Predicate mirrors
  // the parity test: connected, non-voicemail, non-goal — VOZ-387 dropped the
  // customer-ended/duration narrowing (silent_pickup needs turn counts on ALL
  // of these) and keeps declined contacts IN (a zero-turn call on a declined
  // contact moves declined → silent_pickup).
  type RawCandidate = CandidateCallRow & { campaign_number_id: string | null };
  const candidatesRaw: RawCandidate[] = [];
  {
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("calls_v2")
        .select("id, campaign_id, campaign_number_id, created_at, status, voicemail, goal_reached, ended_reason, duration_seconds, transcript")
        .gte("created_at", cutoff)
        // Upper bound = the rollup RPCs' p_end: a call landing between the RPC
        // and this fetch would otherwise shift a bucket the rollup never counted.
        .lt("created_at", nowIso)
        .in("status", ["completed", "answered"])
        .not("voicemail", "is", true)
        .not("goal_reached", "is", true)
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

  // Declined-contact lookup (chunked .in() — URL size limit, see old route).
  // VOZ-387: declined contacts stay IN the candidate set; the flag feeds
  // buildCandidateDelta so their zero-turn calls can move declined → silent_pickup.
  // Chunks run CONCURRENTLY (VOZ-387 review): the widened candidate set means
  // ~25 chunks per lookup — awaited one-by-one that alone added seconds per load.
  const IN_CHUNK = 150;
  // PromiseLike + Promise.resolve: supabase query builders are thenables, not Promises.
  const chunked = <T,>(ids: string[], run: (slice: string[]) => PromiseLike<T>): Promise<T>[] => {
    const out: Promise<T>[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(Promise.resolve(run(ids.slice(i, i + IN_CHUNK))));
    return out;
  };
  const contactIds = [...new Set(liveCandidates.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  const declinedIds = new Set<string>();
  {
    const results = await Promise.all(
      chunked(contactIds, (slice) => supabaseAdmin.from("campaign_numbers_v2").select("id, outcome").in("id", slice)),
    );
    for (const { data, error } of results) {
      if (error) {
        console.error("[dashboard/today] candidate contact query failed:", error);
        return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
      }
      for (const n of data ?? []) {
        if ((n.outcome ?? "") === "declined_offer") declinedIds.add(n.id as string);
      }
    }
  }
  const candidates = liveCandidates;

  // SMS attached to candidate calls (drives the SMS neutral shift). Chunked .in().
  const candidateIds = candidates.map((c) => c.id).filter((x): x is string => !!x);
  const smsAttachments: Array<{ call_id: string | null; created_at: string | null }> = [];
  {
    const results = await Promise.all(
      chunked(candidateIds, (slice) =>
        supabaseAdmin
          .from("sms_messages_v2")
          .select("call_id, created_at, status")
          .in("call_id", slice)
          .in("status", ["sent", "delivered"])
          .gte("created_at", cutoff)
          // Same upper bound as the sms rollup's p_end (see the candidate fetch note).
          .lt("created_at", nowIso),
      ),
    );
    for (const { data, error } of results) {
      if (error) {
        console.error("[dashboard/today] candidate sms query failed:", error);
        return NextResponse.json({ error: "Failed to read today's metrics" }, { status: 500 });
      }
      smsAttachments.push(...((data ?? []) as Array<{ call_id: string | null; created_at: string | null }>));
    }
  }

  const delta = buildCandidateDelta(candidates, smsAttachments, todayStartMs, declinedIds);

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
