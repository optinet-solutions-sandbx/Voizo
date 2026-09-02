import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import {
  buildCandidateDelta,
  computeCampaignTableFromRollup,
  FINISHED_IDLE_DAYS,
  type CallRollupRow,
  type CandidateCallRow,
  type DashCampaignRow,
  type SmsRollupRow,
} from "@/lib/dashboardAnalytics";

/**
 * GET /api/dashboard/campaigns?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Rows for the Campaign Performance table (Val's spec). This table has its OWN date
 * range — independent of the global filter bar. Returns ALL live (non-ghost, non-test)
 * campaigns, including zero-call ones, each with a derived DISPLAY status
 * (running / paused / finished — paused-but-idle, past end_at, or never-run all read as
 * "Finished"; presentation-only, idle window = FINISHED_IDLE_DAYS). Read-only; lenient origin.
 *
 * VOZ-283 (2026-08-04): numbers now come from the dashboard_call_rollup /
 * dashboard_sms_rollup Postgres functions instead of paging every calls_v2 /
 * sms_messages_v2 row through JS (the incident's 31k-row days made that fetch
 * ~47k rows / ~16MB per load). Byte-parity with the old path is proven by
 * src/lib/dashboardRollup.parity.test.ts (run against live prod data) — the
 * response JSON shape is unchanged. Declined outcomes are now classified inside
 * the SQL, so `outcome` is no longer fetched.
 *
 * 2026-08-05: `players` also moved into SQL (campaign_roster_counts). VOZ-283 left
 * the roster as a full-table fetchAllRows purely to COUNT rows in JS — 27 sequential
 * round-trips at 26.6k rows, which turned out to BE this route's latency (measured
 * 15.5-16.8s, vs 0.9-1.4s for /api/qa-prompt-testing/campaigns running the same
 * lifetime dashboard_call_rollup without that leg). The lifetime rollup scan was
 * never the bottleneck; round-trip count was. See 2026-08-05_campaign_roster_counts_rpc.sql.
 */
const MS_PER_DAY = 86_400_000;

function parseDay(value: string | null, fallbackMs: number, endOfDay: boolean): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value ?? "");
  if (!m) return fallbackMs;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return endOfDay ? base + MS_PER_DAY - 1 : base;
}

export async function GET(request: NextRequest) {
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
  const { searchParams } = new URL(request.url);
  const toMs = parseDay(searchParams.get("to"), now, true);
  const fromMs = parseDay(searchParams.get("from"), now - 30 * MS_PER_DAY, false);

  // Rollups are campaign-LIFETIME ([epoch, now]) — matching the old route, where
  // Attempts/Reached were lifetime totals and from/to only echo in the response
  // (the date picker filters WHICH campaigns list client-side, not the numbers).
  const [callRollupRes, smsRollupRes, campaigns, rosterRes] = await Promise.all([
    supabaseAdmin.rpc("dashboard_call_rollup", {
      p_start: new Date(0).toISOString(),
      p_end: new Date(now).toISOString(),
    }),
    supabaseAdmin.rpc("dashboard_sms_rollup", {
      p_start: new Date(0).toISOString(),
      p_end: new Date(now).toISOString(),
    }),
    // fetchAllRows pages past PostgREST's 1000-row cap — campaigns_v2 grows
    // daily (recurring day-children); a bare .select() clamps at 1000 with no
    // stable order, so table rows would vanish arbitrarily past the cap.
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      // cio_workspace: the per-row brand chip (VOZ-216).
      // script_id/script_name/segment_id: the section filters + mass export (Val 2026-08-07).
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at, script_id, script_name, segment_id, parent_campaign_id",
      "id",
    ),
    // Players (full roster count) is campaign-LIFETIME. Counted in SQL: paging the
    // whole table to count rows in JS was 27 sequential round-trips (26.6k rows) and
    // WAS this route's wall clock — 15.5-16.8s prod, vs 0.9-1.4s for the same
    // lifetime rollup without this leg. One GROUP BY, one round-trip.
    supabaseAdmin.rpc("campaign_roster_counts"),
  ]);

  if (callRollupRes.error || smsRollupRes.error || rosterRes.error) {
    console.error(
      "[dashboard/campaigns] query failed:",
      callRollupRes.error ?? smsRollupRes.error ?? rosterRes.error,
    );
    return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
  }

  const playersByCampaign = new Map<string, number>();
  for (const r of (rosterRes.data ?? []) as Array<{ campaign_id: string; players: number }>) {
    playersByCampaign.set(r.campaign_id, Number(r.players) || 0);
  }

  // ── Transcript-candidate fetch (the VOZ-387 move map, for THIS surface) ────
  // The rollups are lean: the SQL cannot count turns, so a dead-air pickup reads
  // as a reached human and an agent-timeout reads as an early hang-up. /today has
  // carried the correction since VOZ-387; this table did not, and it is the one
  // Val reads — it showed Reached 980 where the classifier said 379 over 4 UTC days.
  //
  // Predicate + paging mirror /api/dashboard/today VERBATIM (keyset, never a bare
  // select's 1000-row clamp). Lifetime, matching the rollups' p_start=epoch.
  // Measured 2026-08-18: 5,918 candidate rows lifetime (~1.2 MB of transcript,
  // 6 pages) out of 58,696 calls — the predicate is ~10% of the table, which is
  // why this is affordable where VOZ-283's all-rows fetch was not.
  //
  // Latency cost, measured the same day: existing legs 993 ms, candidate pages
  // +865 ms, contact/SMS chunks +783 ms → ~2.6 s (was ~1.0 s). Kept SEQUENTIAL
  // and structurally identical to /api/dashboard/today on purpose — that shape
  // is already reviewed and shipped. If this route's wall clock matters, the
  // candidate fetch depends only on `nowIso` and can move into the Promise.all
  // above (~800 ms back); it needs an error-collect rather than an early return.
  const nowIso = new Date(now).toISOString();
  type RawCandidate = CandidateCallRow & { campaign_number_id: string | null };
  const candidatesRaw: RawCandidate[] = [];
  {
    let lastId = "00000000-0000-0000-0000-000000000000";
    for (;;) {
      const { data, error } = await supabaseAdmin
        .from("calls_v2")
        .select("id, campaign_id, campaign_number_id, created_at, status, voicemail, goal_reached, ended_reason, duration_seconds, transcript")
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
        console.error("[dashboard/campaigns] candidate query failed:", error);
        return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
      }
      candidatesRaw.push(...((data ?? []) as unknown as RawCandidate[]));
      if (!data || data.length < 1000) break;
      lastId = (data[data.length - 1] as { id: string }).id;
    }
  }

  // Ghost/test exclusion (the rollups exclude in SQL; candidates must match).
  const campIndex = new Map((campaigns as unknown as DashCampaignRow[]).map((c) => [c.id, c]));
  const candidates = candidatesRaw.filter((c) => {
    const camp = campIndex.get(c.campaign_id);
    return camp && camp.source !== "ghost_portal" && camp.is_test !== true;
  });

  // Declined contacts stay IN the candidate set — the flag lets a zero-turn call
  // on a declined contact move declined → silent_pickup (VOZ-387). Chunked .in()
  // run CONCURRENTLY: ~40 chunks at this row count, awaited one-by-one that alone
  // would add seconds per load.
  const IN_CHUNK = 150; // PostgREST ~16KB URL header guard
  const chunked = <T,>(ids: string[], run: (slice: string[]) => PromiseLike<T>): Promise<T>[] => {
    const out: Promise<T>[] = [];
    for (let i = 0; i < ids.length; i += IN_CHUNK) out.push(Promise.resolve(run(ids.slice(i, i + IN_CHUNK))));
    return out;
  };
  const contactIds = [...new Set(candidates.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  const declinedIds = new Set<string>();
  {
    const results = await Promise.all(
      chunked(contactIds, (slice) => supabaseAdmin.from("campaign_numbers_v2").select("id, outcome").in("id", slice)),
    );
    for (const { data, error } of results) {
      if (error) {
        console.error("[dashboard/campaigns] candidate contact query failed:", error);
        return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
      }
      for (const n of data ?? []) {
        if ((n.outcome ?? "") === "declined_offer") declinedIds.add(n.id as string);
      }
    }
  }

  // SMS attached to candidate calls (drives the SMS card's reclassification).
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
          // Same upper bound as the sms rollup's p_end (see the candidate fetch note).
          .lt("created_at", nowIso),
      ),
    );
    for (const { data, error } of results) {
      if (error) {
        console.error("[dashboard/campaigns] candidate sms query failed:", error);
        return NextResponse.json({ error: "Failed to read campaigns" }, { status: 500 });
      }
      smsAttachments.push(...((data ?? []) as Array<{ call_id: string | null; created_at: string | null }>));
    }
  }

  // todayStartMs is irrelevant here (this surface has no "today" block) — pass the
  // upper bound so the per-campaign TODAY maps stay empty and unused.
  const delta = buildCandidateDelta(candidates, smsAttachments, now, declinedIds);

  const rows = computeCampaignTableFromRollup(
    (callRollupRes.data ?? []) as CallRollupRow[],
    (smsRollupRes.data ?? []) as SmsRollupRow[],
    campaigns as unknown as DashCampaignRow[],
    now,
    FINISHED_IDLE_DAYS,
    playersByCampaign,
    delta.campaignMoveRows,
  );

  // Ghost/test campaigns never surface in rows; strip their rollup rows too so
  // the client-side summary can't count what the table refuses to list.
  const liveIds = new Set(rows.map((r) => r.id));
  const callRollup = ((callRollupRes.data ?? []) as CallRollupRow[]).filter((r) => liveIds.has(r.campaign_id));
  const smsRollup = ((smsRollupRes.data ?? []) as SmsRollupRow[]).filter((r) => liveIds.has(r.campaign_id));
  const moves = delta.campaignMoveRows.filter((r) => liveIds.has(r.campaign_id));

  return NextResponse.json({
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    rows,
    // Day-grain rollup rows (already fetched for the table sums above — this
    // reuses, not re-queries). The client windows/sums these per the ACTIVE
    // filters for the section summary block + mass export (Val 2026-08-07),
    // so summary === sum of listed rows by construction.
    //
    // `moves` MUST ride along: summarizeRollupWindow runs on the CLIENT, and
    // without the same move map the summary block would read the lean numbers
    // while the rows above it read the corrected ones. Same (campaign, day)
    // grain as the rollup rows, so it windows identically. No transcript text
    // crosses the wire — only counts (PII parsimony).
    rollup: { calls: callRollup, sms: smsRollup, moves },
  });
}
