import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import {
  buildCampaignIndex,
  filterCalls,
  computeGlobalKpis,
  computePromptRollups,
  computeTrend,
  computeDailyVolume,
  computeHeatmap,
  representativeBaseBySha,
  bestByPositiveResponse,
  smsSentByCampaign,
  computeRangedPerf,
  perfForCampaignScope,
  type DashCallRow,
  type DashCampaignRow,
  type DashSmsRow,
  type TodayPerfDay,
} from "@/lib/dashboardAnalytics";
import { resolvePromptByCampaign } from "@/lib/promptResolution";
import { fetchAllRows } from "@/lib/supabaseFetchAll";
import { formatCampaign, campaignIdsForCountry } from "@/lib/campaignDisplay";

/**
 * GET /api/dashboard/analytics
 *
 * The filtered "Global Performance" data (Val's spec). The filter bar drives this:
 *   range=7d|14d|30d (default 30d) · campaigns=id,id · agent=<voice_id> · phone=<free text>
 * (prompt= is deferred to the prompt-attribution slice.)
 *
 * Returns the KPI grid (Row 1 totals + Row 2 best campaign/agent), the dropdown option
 * lists, and any phone-lookup match banner. Ghost + test campaigns excluded by filterCalls.
 * Success% = goal/connected; Connect = ANSWER (completed, incl. voicemail). Read-only.
 */
const MS_PER_DAY = 86_400_000;
const RANGE_DAYS: Record<string, number> = { "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90 };

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

  const { searchParams } = new URL(request.url);
  const rangeKey = searchParams.get("range") ?? "30d";
  const rangeDays = RANGE_DAYS[rangeKey] ?? 30;
  const campaignsParam = searchParams.get("campaigns");
  const campaignIds = campaignsParam ? campaignsParam.split(",").filter(Boolean) : null;
  const country = searchParams.get("country");
  const promptSha = searchParams.get("prompt");
  const phone = (searchParams.get("phone") ?? "").trim();

  const now = Date.now();
  const startMs = now - rangeDays * MS_PER_DAY;
  const startIso = new Date(startMs).toISOString();

  // Phone lookup → matching campaign_number_ids + the campaigns they belong to.
  let numberIds: string[] | null = null;
  const matchedCampaignIds = new Set<string>();
  if (phone) {
    const needle = phone.replace(/[^\d+]/g, "");
    if (needle) {
      const { data: nums } = await supabaseAdmin
        .from("campaign_numbers_v2")
        .select("id, campaign_id, phone_e164")
        .ilike("phone_e164", `%${needle}%`)
        .limit(2000);
      numberIds = (nums ?? []).map((n) => n.id as string);
      (nums ?? []).forEach((n) => matchedCampaignIds.add(n.campaign_id as string));
    }
  }

  // Page past PostgREST's 1000-row cap. calls_v2 exceeds it within the 30d window
  // (1613 rows on 2026-06-17) — unbounded, it silently truncated the chart, KPIs,
  // trend, and heatmap to the first 1000. campaigns_v2 is paged too (defensive: it
  // feeds the index filterCalls joins against). fetchAllRows degrades-to-partial and
  // logs loudly on a page error, so there's no all-or-nothing 500 here.
  const [callRows, campaignRows, smsRows] = await Promise.all([
    fetchAllRows(
      supabaseAdmin,
      "calls_v2",
      "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds",
      "id",
      undefined,
      { column: "created_at", value: startIso },
    ),
    fetchAllRows(
      supabaseAdmin,
      "campaigns_v2",
      "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, system_prompt, start_at, created_at, end_at, timezone",
      "id",
    ),
    // SMS-sent series/columns (Slice 3): windowed, scoped to in-filter campaigns below.
    fetchAllRows(
      supabaseAdmin,
      "sms_messages_v2",
      "campaign_id, created_at, status, call_id, campaign_number_id",
      "id",
      undefined,
      { column: "created_at", value: startIso },
    ),
  ]);

  const campaigns = campaignRows as unknown as (DashCampaignRow & { system_prompt?: string | null })[];
  const index = buildCampaignIndex(campaigns);
  const live = campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true);

  // Per-campaign prompt identity (sha + label + base agent) — shared resolver (chunked .in()).
  const promptByCampaign = await resolvePromptByCampaign(live);

  let filtered = filterCalls(
    callRows as unknown as DashCallRow[],
    { startMs, endMs: now, campaignIds, numberIds },
    index,
  );
  // Country filter (replaces the agent filter): keep calls whose campaign parses to the chosen country.
  if (country) {
    const countryIds = campaignIdsForCountry(live, country);
    filtered = filtered.filter((c) => countryIds.has(c.campaign_id));
  }
  // Prompt filter (prompt is per-campaign in v1): keep calls whose campaign's prompt hash matches.
  if (promptSha) filtered = filtered.filter((c) => promptByCampaign.get(c.campaign_id)?.sha === promptSha);

  const global = computeGlobalKpis(filtered, index);
  const prompts = computePromptRollups(filtered, promptByCampaign);
  const bestPrompt = bestByPositiveResponse(prompts, (r) => ({ key: r.sha, label: r.label }));

  // SMS-sent (Slice 3): scope to the campaigns the call filter kept, then count per campaign /
  // per base-agent / per prompt sha so the ranked tables + trend can surface "SMS sent".
  const inScopeCampaigns = new Set(filtered.map((c) => c.campaign_id));
  const scopedSms = (smsRows as unknown as DashSmsRow[]).filter((m) => inScopeCampaigns.has(m.campaign_id));
  const smsByCampaign = smsSentByCampaign(scopedSms);
  const smsByAgent = new Map<string, number>();
  const smsByPrompt = new Map<string, number>();
  for (const [campId, n] of smsByCampaign) {
    const agentId = index.get(campId)?.base_assistant_id ?? null;
    if (agentId) smsByAgent.set(agentId, (smsByAgent.get(agentId) ?? 0) + n);
    const sha = promptByCampaign.get(campId)?.sha ?? null;
    if (sha) smsByPrompt.set(sha, (smsByPrompt.get(sha) ?? 0) + n);
  }

  // Declined contacts for the Reached split (campaign_numbers_v2.outcome='declined_offer'), scoped
  // to the filtered call set. Chunk .in() at 150 (PostgREST ~16KB URL header guard).
  const declinedIds = new Set<string>();
  const declinedNumIds = [...new Set(filtered.map((c) => c.campaign_number_id).filter((x): x is string => !!x))];
  const DECLINED_IN_CHUNK = 150;
  for (let i = 0; i < declinedNumIds.length; i += DECLINED_IN_CHUNK) {
    const { data, error } = await supabaseAdmin
      .from("campaign_numbers_v2")
      .select("id, outcome")
      .in("id", declinedNumIds.slice(i, i + DECLINED_IN_CHUNK));
    if (error) {
      // Degrade, don't fail: the Reached→Declined split is slightly under-counted; everything else is fine.
      console.error("[dashboard/analytics] declined-numbers query failed:", error);
      break;
    }
    for (const n of (data ?? []) as { id: string; outcome: string | null }[]) {
      if ((n.outcome ?? "") === "declined_offer") declinedIds.add(n.id);
    }
  }

  // Ranged 3-card Performance (Global Performance, Val's mockup). Reuses the already-filtered in-memory
  // call set (no extra fetch) + the lean transcript-less classifier. Isolated failure domain: a perf
  // error must NOT take down the charts/tables/leaderboard, so degrade to perf:null and log with counts.
  let perf: TodayPerfDay | null = null;
  try {
    perf = computeRangedPerf(filtered, scopedSms, declinedIds, startMs, now);
  } catch (e) {
    console.error("[dashboard/analytics] computeRangedPerf failed:", e, { calls: filtered.length, sms: scopedSms.length });
    perf = null;
  }

  // Dropdown options — only campaigns with activity in this window (calls or SMS), so stale/empty
  // ones stop cluttering the filter. Built from the RAW windowed sets (not `filtered`) so the option
  // list is stable regardless of what's currently selected. `startAt` lets the client disambiguate
  // same-named campaigns by date.
  const windowedCampaignIds = new Set<string>([
    ...(callRows as unknown as DashCallRow[]).map((c) => c.campaign_id),
    ...(smsRows as unknown as DashSmsRow[]).map((m) => m.campaign_id),
  ]);
  const inWindowLive = live.filter((c) => windowedCampaignIds.has(c.id));
  const campaignOptions = inWindowLive
    .map((c) => ({ id: c.id, name: c.name, startAt: c.start_at ?? c.created_at ?? null }))
    .sort((a, b) => a.name.localeCompare(b.name));
  // Country filter options (replaces the agent filter, Val 2026-07-07): distinct parsed countries
  // among the in-window campaigns, by the SAME L7_<CC>_ parse used for filter membership. Campaigns
  // with no parseable country contribute nothing (and can't be reached by the country filter).
  const countrySet = new Set<string>();
  for (const c of inWindowLive) {
    const ctry = formatCampaign(c.name).country;
    if (ctry) countrySet.add(ctry);
  }
  const countryOptions = [...countrySet].sort().map((c) => ({ value: c, label: c }));
  const baseBySha = representativeBaseBySha(promptByCampaign);
  // First campaign that ran each prompt sha — lets the UI open the full prompt (PromptModal) for a
  // representative campaign (the per-campaign prompt endpoint is the source of the full text).
  const campaignIdBySha = new Map<string, string>();
  for (const [campId, p] of promptByCampaign) if (!campaignIdBySha.has(p.sha)) campaignIdBySha.set(p.sha, campId);
  const promptOptions = [...new Map([...promptByCampaign.values()].map((p) => [p.sha, p.label])).entries()]
    .map(([sha, label]) => ({ sha, label, baseAssistantId: baseBySha.get(sha) ?? null }))
    .sort((a, b) => a.label.localeCompare(b.label));

  const matchedCampaigns = phone
    ? campaigns.filter((c) => matchedCampaignIds.has(c.id)).map((c) => ({ id: c.id, name: c.name }))
    : [];

  // Per-entity perf for the Top Performers breakdown cards (Slice E). In-memory over the already-
  // filtered set; each isolated (try/catch → null) so one entity's failure can't drop the section.
  const bestPerf = (ids: Set<string> | null): TodayPerfDay | null => {
    if (!ids || ids.size === 0) return null;
    try {
      return perfForCampaignScope(filtered, scopedSms, declinedIds, startMs, now, ids);
    } catch (e) {
      console.error("[dashboard/analytics] perfForCampaignScope failed:", e, { ids: ids.size });
      return null;
    }
  };
  const campaignScope = global.bestCampaign ? new Set([global.bestCampaign.key]) : null;
  const agentScope = global.bestAgent
    ? new Set(live.filter((c) => (c.base_assistant_id ?? null) === global.bestAgent!.key).map((c) => c.id))
    : null;
  const promptScope = bestPrompt
    ? new Set([...promptByCampaign].filter(([, pp]) => pp.sha === bestPrompt.key).map(([id]) => id))
    : null;

  return NextResponse.json({
    rangeDays,
    kpis: global.kpis,
    campaignCount: global.campaignCount,
    best: {
      campaign: global.bestCampaign ? { ...global.bestCampaign, perf: bestPerf(campaignScope) } : null,
      agent: global.bestAgent ? { ...global.bestAgent, perf: bestPerf(agentScope) } : null,
      prompt: bestPrompt ? { ...bestPrompt, perf: bestPerf(promptScope) } : null,
    },
    campaigns: global.campaignRollups.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      status: r.status,
      baseAssistantId: r.baseAssistantId,
      calls: r.calls,
      connectRate: r.connectRate,
      successRate: r.successRate,
      reach: r.reach,
      positiveResponseRate: r.positiveResponseRate,
      smsSent: smsByCampaign.get(r.id) ?? 0,
    })),
    agents: global.agentRollups.map((r) => ({
      baseAssistantId: r.baseAssistantId,
      calls: r.calls,
      connected: r.connected,
      terminal: r.terminal,
      connectRate: r.connectRate,
      successRate: r.successRate,
      reach: r.reach,
      positiveResponseRate: r.positiveResponseRate,
      smsSent: smsByAgent.get(r.baseAssistantId) ?? 0,
      campaignCount: r.campaignCount,
    })),
    prompts: prompts.map((r) => ({
      sha: r.sha,
      label: r.label,
      baseAssistantId: r.baseAssistantId,
      campaignId: campaignIdBySha.get(r.sha) ?? null,
      calls: r.calls,
      connectRate: r.connectRate,
      successRate: r.successRate,
      reach: r.reach,
      positiveResponseRate: r.positiveResponseRate,
      smsSent: smsByPrompt.get(r.sha) ?? 0,
      campaignCount: r.campaignCount,
    })),
    trend: computeTrend(filtered, startMs, now, scopedSms),
    dailyVolume: computeDailyVolume(filtered, campaigns, startMs, now),
    heatmap: computeHeatmap(filtered, campaigns),
    perf,
    options: { campaigns: campaignOptions, countries: countryOptions, prompts: promptOptions },
    phone: { query: phone || null, matchedCampaigns },
  });
}
