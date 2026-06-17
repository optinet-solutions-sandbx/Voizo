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
  promptLabel,
  representativeBaseBySha,
  bestBySuccess,
  type DashCallRow,
  type DashCampaignRow,
} from "@/lib/dashboardAnalytics";
import { sha256Hex } from "@/lib/promptVersionExtract";
import { fetchAllRows } from "@/lib/supabaseFetchAll";

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
  const agent = searchParams.get("agent");
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
  const [callRows, campaignRows] = await Promise.all([
    fetchAllRows(
      supabaseAdmin,
      "calls_v2",
      "campaign_id, campaign_number_id, status, goal_reached, created_at",
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
  ]);

  const campaigns = campaignRows as unknown as (DashCampaignRow & { system_prompt?: string | null })[];
  const index = buildCampaignIndex(campaigns);
  const live = campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true);

  // Per-campaign prompt identity (sha + label): latest prompt_versions snapshot if any,
  // else the campaign's stored system_prompt (hashed the same way so identical text groups).
  const promptByCampaign = new Map<string, { sha: string; label: string; baseAssistantId: string | null }>();
  const liveIds = live.map((c) => c.id);
  const latestByCampaign = new Map<string, { system_prompt: string; sha: string }>();
  if (liveIds.length) {
    const { data: pv } = await supabaseAdmin
      .from("prompt_versions")
      .select("campaign_id, system_prompt, prompt_sha256, created_at")
      .in("campaign_id", liveIds)
      .order("created_at", { ascending: false });
    for (const v of (pv ?? []) as { campaign_id: string; system_prompt: string; prompt_sha256: string }[]) {
      if (!latestByCampaign.has(v.campaign_id)) {
        latestByCampaign.set(v.campaign_id, { system_prompt: v.system_prompt, sha: v.prompt_sha256 });
      }
    }
  }
  for (const c of live) {
    const baseAssistantId = c.base_assistant_id ?? null;
    const latest = latestByCampaign.get(c.id);
    if (latest) {
      promptByCampaign.set(c.id, { sha: latest.sha, label: promptLabel(latest.system_prompt, latest.sha), baseAssistantId });
    } else if (c.system_prompt) {
      const sha = sha256Hex(c.system_prompt);
      promptByCampaign.set(c.id, { sha, label: promptLabel(c.system_prompt, sha), baseAssistantId });
    }
  }

  let filtered = filterCalls(
    callRows as unknown as DashCallRow[],
    { startMs, endMs: now, campaignIds, voiceId: agent, numberIds },
    index,
  );
  // Prompt filter (prompt is per-campaign in v1): keep calls whose campaign's prompt hash matches.
  if (promptSha) filtered = filtered.filter((c) => promptByCampaign.get(c.campaign_id)?.sha === promptSha);

  const global = computeGlobalKpis(filtered, index);
  const prompts = computePromptRollups(filtered, promptByCampaign);
  const bestPrompt = bestBySuccess(prompts, (r) => ({ key: r.sha, label: r.label }));

  // Dropdown options — full live set.
  const campaignOptions = live.map((c) => ({ id: c.id, name: c.name })).sort((a, b) => a.name.localeCompare(b.name));
  const agentMap = new Map<string, string | null>();
  for (const c of live) {
    if (c.voice_id && !agentMap.has(c.voice_id)) agentMap.set(c.voice_id, c.vapi_assistant_name ?? null);
  }
  const agentOptions = [...agentMap.entries()]
    .map(([voiceId, label]) => ({ voiceId, label }))
    .sort((a, b) => (a.label ?? a.voiceId).localeCompare(b.label ?? b.voiceId));
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

  return NextResponse.json({
    rangeDays,
    kpis: global.kpis,
    campaignCount: global.campaignCount,
    best: { campaign: global.bestCampaign, agent: global.bestAgent, prompt: bestPrompt },
    campaigns: global.campaignRollups.map((r) => ({
      id: r.id,
      name: r.name,
      country: r.country,
      status: r.status,
      baseAssistantId: r.baseAssistantId,
      calls: r.calls,
      connectRate: r.connectRate,
      successRate: r.successRate,
    })),
    agents: global.agentRollups.map((r) => ({
      baseAssistantId: r.baseAssistantId,
      calls: r.calls,
      connected: r.connected,
      terminal: r.terminal,
      connectRate: r.connectRate,
      successRate: r.successRate,
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
      campaignCount: r.campaignCount,
    })),
    trend: computeTrend(filtered, startMs, now),
    dailyVolume: computeDailyVolume(filtered, campaigns, startMs, now),
    heatmap: computeHeatmap(filtered, campaigns),
    options: { campaigns: campaignOptions, agents: agentOptions, prompts: promptOptions },
    phone: { query: phone || null, matchedCampaigns },
  });
}
