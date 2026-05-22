import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { rejectIfCrossOrigin, rejectIfCrossOriginStrict } from "@/lib/csrf";
import { CONTACT_OUTCOMES } from "@/lib/contactOutcomes";
import { MAX_CANDIDATES } from "@/lib/audienceLimits";

/**
 * /api/audience/segments
 *
 *   GET  — list local segments (snapshot counts, source campaign name)
 *   POST — preview (commit:false) or create (commit:true) a segment by
 *          carving outcome-tagged phones out of a source campaign with
 *          DNC + N-day recency scrubbing applied.
 *
 * Plan: .claude/plans/new-shift-picking-gentle-puffin.md Slice 1.
 *
 * Suppression scrub MIRRORS the dialer's findNextNumber pattern
 * (src/lib/dialer.ts: suppression_list + do_not_call.archived=false). The
 * dialer is NOT imported — call-path discipline (CLAUDE.md non-negotiable #4).
 *
 * Recency scrub uses `campaign_numbers_v2.last_attempted_at > cutoff` (same
 * pattern as resume-diff/route.ts; cheaper than joining calls_v2).
 */

// Outcomes that the operator may select from. Anything not in this list is
// silently dropped from the filter — keeps the API safe even if the UI is
// bypassed. See plan's "Cost / compliance guardrails" table.
const ALLOWED_OUTCOMES = new Set([
  // Non-terminal — source could re-dial these on resume; soft-marked below.
  "pending",
  "pending_retry",
  // Terminal/administrative — safe to recycle.
  "unreached",
  "recently_called_elsewhere",
  "removed_from_segment",
  // Sensitive (UI gates with a friction modal; API trusts the operator):
  "declined_offer",
  "not_interested",
  "sent_sms",
]);

// Outcomes that would cause double-dial if the SOURCE campaign is resumed
// after recycling. We soft-mark these on the source as 'removed_from_segment'
// during commit. See the soft-mark block at the end of POST.
const NON_TERMINAL_OUTCOMES = new Set(["pending", "pending_retry"]);

interface FilterInput {
  sourceCampaignId: string;
  outcomesIncluded: string[];
  dncScrubbed: boolean;
  recentWindowDays: number;
}

interface FilterResult {
  matched: number;       // raw candidates from source campaign
  scrubbedDnc: number;   // removed by DNC scrub
  scrubbedRecent: number; // removed by N-day recency scrub
  net: Array<{ phone_e164: string; source_outcome: string; source_attempts: number | null }>;
}

async function runFilter(input: FilterInput): Promise<FilterResult | { error: string; status: number }> {
  // ── 1. Candidates from source campaign ──
  const { data: candidates, error: candErr } = await supabaseAdmin
    .from("campaign_numbers_v2")
    .select("phone_e164, outcome, attempt_count")
    .eq("campaign_id", input.sourceCampaignId)
    .in("outcome", input.outcomesIncluded);

  if (candErr) {
    return { error: `Candidate query failed: ${candErr.message}`, status: 500 };
  }

  const rows = candidates ?? [];
  if (rows.length === 0) {
    return { matched: 0, scrubbedDnc: 0, scrubbedRecent: 0, net: [] };
  }
  if (rows.length > MAX_CANDIDATES) {
    return {
      error: `Source campaign yielded ${rows.length} candidates; cap is ${MAX_CANDIDATES}. Narrow your outcome filter or split into smaller segments.`,
      status: 413,
    };
  }

  const phones = rows.map((r) => r.phone_e164 as string);

  // ── 2. DNC scrub (suppression_list V2 + do_not_call V1, both checked) ──
  let scrubbedDnc = 0;
  const dncSet = new Set<string>();
  if (input.dncScrubbed) {
    const [supRes, dncRes] = await Promise.all([
      supabaseAdmin
        .from("suppression_list")
        .select("phone_e164")
        .in("phone_e164", phones),
      supabaseAdmin
        .from("do_not_call")
        .select("phone_number")
        .eq("archived", false)
        .in("phone_number", phones),
    ]);
    for (const r of supRes.data ?? []) dncSet.add(r.phone_e164 as string);
    for (const r of dncRes.data ?? []) dncSet.add(r.phone_number as string);
    scrubbedDnc = dncSet.size;
  }

  // ── 3. N-day recency scrub (other campaigns' recent contact attempts) ──
  let scrubbedRecent = 0;
  const recentSet = new Set<string>();
  if (input.recentWindowDays > 0) {
    const cutoffIso = new Date(
      Date.now() - input.recentWindowDays * 24 * 60 * 60 * 1000,
    ).toISOString();
    const { data: recentRows, error: recentErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .neq("campaign_id", input.sourceCampaignId)
      .in("phone_e164", phones)
      .in("outcome", CONTACT_OUTCOMES)
      .gt("last_attempted_at", cutoffIso);
    if (recentErr) {
      return { error: `Recency query failed: ${recentErr.message}`, status: 500 };
    }
    for (const r of recentRows ?? []) recentSet.add(r.phone_e164 as string);
    scrubbedRecent = recentSet.size;
  }

  // ── 4. Compose net list (dedupe by phone — first occurrence wins) ──
  const seen = new Set<string>();
  const net: FilterResult["net"] = [];
  for (const r of rows) {
    const phone = r.phone_e164 as string;
    if (seen.has(phone)) continue;
    if (dncSet.has(phone)) continue;
    if (recentSet.has(phone)) continue;
    seen.add(phone);
    net.push({
      phone_e164: phone,
      source_outcome: r.outcome as string,
      source_attempts: (r.attempt_count as number) ?? null,
    });
  }

  return { matched: rows.length, scrubbedDnc, scrubbedRecent, net };
}

// ── GET — list segments ───────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const csrf = rejectIfCrossOrigin(request);
  if (csrf) return csrf;

  const { data, error } = await supabaseAdmin
    .from("local_segments")
    .select(
      "id, name, source_campaign_id, source_campaign_name, outcomes_included, dnc_scrubbed, recent_window_days, total_count, scrubbed_count, created_at, created_by",
    )
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ segments: data ?? [] });
}

// ── POST — preview (commit:false) or create (commit:true) ─────────────────

interface PostBody {
  name?: unknown;
  source_campaign_id?: unknown;
  outcomes_included?: unknown;
  dnc_scrubbed?: unknown;
  recent_window_days?: unknown;
  commit?: unknown;
}

export async function POST(request: NextRequest) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── Validate ──
  const sourceCampaignId =
    typeof body.source_campaign_id === "string" ? body.source_campaign_id : null;
  if (!sourceCampaignId) {
    return NextResponse.json(
      { error: "source_campaign_id (uuid string) is required" },
      { status: 400 },
    );
  }

  const outcomesRaw = Array.isArray(body.outcomes_included) ? body.outcomes_included : [];
  const outcomesIncluded = outcomesRaw.filter(
    (o): o is string => typeof o === "string" && ALLOWED_OUTCOMES.has(o),
  );
  if (outcomesIncluded.length === 0) {
    return NextResponse.json(
      { error: "outcomes_included must contain at least one allowed outcome" },
      { status: 400 },
    );
  }

  const dncScrubbed = body.dnc_scrubbed !== false; // default true
  const recentWindowDays =
    typeof body.recent_window_days === "number" &&
    Number.isFinite(body.recent_window_days) &&
    body.recent_window_days >= 0
      ? Math.floor(body.recent_window_days)
      : 7;

  const commit = body.commit === true;

  // ── Look up source campaign (snapshot name + status for the running-guard) ──
  const { data: sourceCampaign, error: sourceErr } = await supabaseAdmin
    .from("campaigns_v2")
    .select("id, name, status")
    .eq("id", sourceCampaignId)
    .single();
  if (sourceErr || !sourceCampaign) {
    return NextResponse.json({ error: "Source campaign not found" }, { status: 404 });
  }

  // Defense-in-depth (audit H3): the UI already filters source candidates to
  // completed/paused, but a direct API call (or an operator who resumed the
  // source in another tab between selection and commit) can bypass that. If
  // the source is running, the soft-mark UPDATE races the dialer and one of
  // them silently loses (call fires + outcome history corrupted, or our
  // UPDATE stomps a terminal outcome that arrived microseconds earlier).
  // Hard-reject; operator must pause first. Cost-protective per CLAUDE.md #4.
  if (sourceCampaign.status === "running") {
    return NextResponse.json(
      {
        error:
          "Source campaign is currently running. Pause it before carving a segment so the dialer can't race the soft-mark.",
      },
      { status: 409 },
    );
  }

  // ── Run the filter ──
  const result = await runFilter({
    sourceCampaignId,
    outcomesIncluded,
    dncScrubbed,
    recentWindowDays,
  });
  if ("error" in result) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }

  // ── Preview path (no writes) ──
  if (!commit) {
    return NextResponse.json({
      preview: {
        matched: result.matched,
        scrubbed_dnc: result.scrubbedDnc,
        scrubbed_recent: result.scrubbedRecent,
        net: result.net.length,
      },
    });
  }

  // ── Commit path (insert segment + numbers) ──
  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (name.length === 0 || name.length > 120) {
    return NextResponse.json(
      { error: "name is required (1–120 chars) when commit:true" },
      { status: 400 },
    );
  }

  if (result.net.length === 0) {
    return NextResponse.json(
      { error: "Filter matched zero phones after scrubbing — nothing to save." },
      { status: 422 },
    );
  }

  const { data: segmentRow, error: insErr } = await supabaseAdmin
    .from("local_segments")
    .insert({
      name,
      source_campaign_id: sourceCampaignId,
      source_campaign_name: sourceCampaign.name as string,
      outcomes_included: outcomesIncluded,
      dnc_scrubbed: dncScrubbed,
      recent_window_days: recentWindowDays,
      total_count: result.net.length,
      scrubbed_count: result.scrubbedDnc + result.scrubbedRecent,
    })
    .select(
      "id, name, source_campaign_id, source_campaign_name, outcomes_included, dnc_scrubbed, recent_window_days, total_count, scrubbed_count, created_at, created_by",
    )
    .single();

  if (insErr || !segmentRow) {
    return NextResponse.json(
      { error: `Failed to insert local_segments row: ${insErr?.message ?? "unknown"}` },
      { status: 500 },
    );
  }

  const segmentId = segmentRow.id as string;
  const numberRows = result.net.map((n) => ({
    segment_id: segmentId,
    phone_e164: n.phone_e164,
    source_outcome: n.source_outcome,
    source_attempts: n.source_attempts,
  }));

  // Bulk insert numbers. If this fails, drop the parent row so we don't leave
  // an orphan local_segments entry with total_count > 0 but no children.
  const { error: numbersErr } = await supabaseAdmin
    .from("local_segment_numbers")
    .insert(numberRows);

  if (numbersErr) {
    await supabaseAdmin.from("local_segments").delete().eq("id", segmentId);
    return NextResponse.json(
      { error: `Failed to insert local_segment_numbers: ${numbersErr.message}` },
      { status: 500 },
    );
  }

  // 2026-05-21: Double-dial guardrail. Phones carved from the source's
  // `pending` or `pending_retry` buckets are still dial-eligible on the
  // source if it's resumed — both campaigns would then dial the same number
  // ($0.15/call × N = real cost; complaint risk too). Soft-mark the source's
  // matching rows as 'removed_from_segment' so the source can't pick them up.
  //
  // - Filter by `outcome IN ('pending', 'pending_retry')` so we never stomp
  //   a terminal outcome that arrived between filter and commit.
  // - Non-fatal on error — the segment is the primary artifact; log + move on.
  const nonTerminalPhones = result.net
    .filter((n) => NON_TERMINAL_OUTCOMES.has(n.source_outcome))
    .map((n) => n.phone_e164);

  let softMarkedCount = 0;
  if (nonTerminalPhones.length > 0) {
    const { data: swept, error: sweepErr } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .update({ outcome: "removed_from_segment" })
      .eq("campaign_id", sourceCampaignId)
      .in("phone_e164", nonTerminalPhones)
      .in("outcome", ["pending", "pending_retry"])
      .select("id");
    if (sweepErr) {
      console.warn(
        `[audience] soft-mark failed for source ${sourceCampaignId}: ${sweepErr.message}`,
      );
    } else {
      softMarkedCount = swept?.length ?? 0;
    }
  }

  console.log(
    `[audience] segment created: id=${segmentId} outcomes=${outcomesIncluded.join(",")} ` +
      `matched=${result.matched} scrubbed_dnc=${result.scrubbedDnc} ` +
      `scrubbed_recent=${result.scrubbedRecent} net=${result.net.length} ` +
      `soft_marked=${softMarkedCount}`,
  );

  return NextResponse.json({ segment: segmentRow }, { status: 201 });
}
