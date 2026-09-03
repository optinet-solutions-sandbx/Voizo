"use client";

// Global Performance section (Val's spec). Slice 2: filter scope banner + the full
// filter bar (date range · campaigns multi · agent · prompt · phone-lookup + match
// banner · removable chips · Clear) driving the 6-card KPI grid. Prompt is disabled
// until the prompt-attribution slice. Data: /api/dashboard/analytics.
// Connect = ANSWER (incl. voicemail); Success% = goal/connected. Ghost+test excluded.

import { useCallback, useEffect, useState } from "react";
import { loadSnapshot, saveSnapshot } from "@/lib/sessionSnapshot";
import { Search, X } from "lucide-react";
import SectionIsland, { SectionTick } from "./SectionIsland";
import GlobalExport from "./GlobalExport";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import { formatCampaign, promptAgentLabel, distinctBrandLabels, campaignFilterLabels, campaignRunLabel, campaignGroupHeaderLabels } from "@/lib/campaignDisplay";
// The campaign picker lives in CampaignPicker.tsx since 2026-09-03 (shared with Campaign Performance).
import CampaignPicker from "./CampaignPicker";
import RangeCalendar from "./RangeCalendar";
import { useBaseAgentNames } from "./useBaseAgentNames";
import Leaderboards, { type AgentRow, type CampaignLbRow, type PromptRow } from "./Leaderboards";
import CampaignTable from "./CampaignTable";
import TrendChart from "./TrendChart";
import DailyVolumeChart from "./DailyVolumeChart";
import HeatMap from "./HeatMap";
import ChartStrip from "./ChartStrip";
import ConversionFunnel from "./ConversionFunnel";
import MarketComparison from "./MarketComparison";
// The three PerformanceCards that sat in the overview island were replaced by ConnectRateHero
// (Jasiel 2026-09-02): their Call attempts / Reached / SMS numbers duplicate Campaign
// Performance's own summary below. The drill-down drawer only those cards could open went
// with them; Campaign Performance keeps its own.
import ConnectRateHero from "./ConnectRateHero";
import type { DayCount } from "@/lib/connectRateHero";
import { CardGridSkeleton } from "./loadingSkeletons";
import type { TrendPoint, VolumeResult, HeatmapResult, TodayPerfDay, MarketRow } from "@/lib/dashboardAnalytics";
import { type RangeKey } from "@/lib/rangeWindow";

// RangeKey is shared with the backend window resolver (rangeWindow.ts) so presets / lifetime / custom stay in sync.
const RANGES: RangeKey[] = ["7d", "14d", "30d", "60d", "90d", "lifetime"];
const RANGE_BTN: Record<string, string> = { lifetime: "All" }; // button caption; presets show their raw key
const RANGE_LABEL: Record<RangeKey, string> = { "7d": "Last 7 days", "14d": "Last 14 days", "30d": "Last 30 days", "60d": "Last 60 days", "90d": "Last 90 days", lifetime: "All time", custom: "Custom range" };

export interface BestPerformer {
  key: string;
  label: string;
  positiveResponseRate: number;
  calls: number;
  perf?: TodayPerfDay | null; // per-entity ranged breakdown for the Top Performers cards (Slice E)
}
interface AnalyticsResponse {
  rangeDays: number;
  kpis: {
    calls: number;
    connected: number;
    terminal: number;
    successful: number;
    connectRate: number | null;
    successRate: number | null;
    // Reach / voicemail (call-observability slice) — mirrors RateRow; fills forward from deploy.
    reach: number;
    voicemailEvaluated: number;
    voicemailRate: number | null;
    positiveResponseRate: number | null; // goal_reached / reach (the renamed "success" metric)
  };
  perf: TodayPerfDay | null; // ranged 3-card Performance block (Slice B)
  campaignCount: number;
  best: { campaign: BestPerformer | null; agent: BestPerformer | null; prompt: BestPerformer | null };
  campaigns: CampaignLbRow[];
  agents: AgentRow[];
  prompts: PromptRow[];
  trend: TrendPoint[];
  // Per-day completed/connected for the equal-length window before this one (the hero's
  // comparison). null = no comparable baseline. Absent on older API deploys, which reads as null.
  baseline?: DayCount[] | null;
  dailyVolume: VolumeResult;
  // per-market calls / connected / completed (2026-09-03). Absent on older API deploys.
  markets?: MarketRow[];
  heatmap: HeatmapResult;
  options: {
    // `brand` = campaigns_v2.cio_workspace (VOZ-216); absent on older API deploys.
    // `parentId` = campaigns_v2.parent_campaign_id — groups the daily children under their
    // recurring parent in the filter. Absent on older deploys, which just renders flat.
    campaigns: { id: string; name: string; startAt: string | null; brand?: string | null; parentId?: string | null }[];
    // The recurring parents those children point at. They never appear in `campaigns` (a parent
    // has no calls of its own), and they are HEADERS only — never a selectable campaign id.
    campaignParents?: { id: string; name: string; startAt: string | null; brand?: string | null }[];
    countries: { value: string; label: string }[];
    prompts: { sha: string; label: string; baseAssistantId: string | null }[];
  };
  phone: { query: string | null; matchedCampaigns: { id: string; name: string }[] };
}

export interface Filters {
  range: RangeKey;
  from?: string; // custom range start (yyyy-mm-dd) — set only when range === "custom"
  to?: string;   // custom range end (yyyy-mm-dd)
  campaignIds: string[];
  country: string; // "" = all (friendly country name, e.g. "Australia")
  prompt: string; // "" = all (prompt sha)
  phone: string;
}
// Default 7d (Val 2026-06-26): reach-based metrics (Reached, Positive Response) are only
// fully accurate post voicemail-detection deploy (~19 Jun) — a 7d default keeps them honest.
export const DEFAULTS: Filters = { range: "7d", campaignIds: [], country: "", prompt: "", phone: "" };

interface GlobalPerformanceProps {
  // Controlled by DashboardView (lifted 2026-06-16) so both the running cards and the leaderboard
  // can drive "Filter to this campaign" through the same filter state.
  filters: Filters;
  onChange: (next: Filters) => void;
  // Page-level brand scope from the sidebar switcher (mockup, 2026-09-03). "" = all brands.
  brand: string;
}

function buildQuery(f: Filters, brand: string): string {
  const p = new URLSearchParams();
  if (brand) p.set("brand", brand);
  if (f.range === "custom" && f.from && f.to) {
    p.set("from", f.from);
    p.set("to", f.to);
  } else {
    p.set("range", f.range);
  }
  if (f.campaignIds.length) p.set("campaigns", f.campaignIds.join(","));
  if (f.country) p.set("country", f.country);
  if (f.prompt) p.set("prompt", f.prompt);
  if (f.phone.trim()) p.set("phone", f.phone.trim());
  return p.toString();
}

// Above this many selected campaigns the chip row collapses to a single "N campaigns" chip —
// four fit on one line, thirty do not (measured 2026-08-26: they filled eight rows).
const CHIP_LIST_MAX = 4;


// The "estimated" pill on reach-derived sections is the shared EstBadge (PerformanceCards)
// with tone="warn" — unified 2026-07-02 so the disclosure styling/tooltip can't drift.

export default function GlobalPerformance({ filters, onChange, brand }: GlobalPerformanceProps) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/analytics?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as AnalyticsResponse;
      setData(json);
      saveSnapshot(`dashboard.analytics:${query}`, json);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const query = buildQuery(filters, brand);
  useEffect(() => {
    // Stale-while-revalidate (2026-08-05): paint the last snapshot for THIS filter
    // combination instantly (skeleton gates on !data; `loading` renders the
    // non-destructive "Updating…" pill), then the debounced fetch replaces it.
    const snap = loadSnapshot<AnalyticsResponse>(`dashboard.analytics:${query}`);
    if (snap) {
      setData(snap);
      setError(null);
    }
    const id = setTimeout(() => load(query), 300); // debounce (covers phone typing)
    return () => clearTimeout(id);
  }, [query, load]);

  const baseAgentName = useBaseAgentNames();
  // Prompt labels lead with the base-agent NAME (resolved client-side from baseAssistantId) + the
  // server's de-boilerplated snippet+sha — shared across the filter dropdown, chips and Best-Prompt card.
  const promptBaseBySha = new Map((data?.options.prompts ?? []).map((p) => [p.sha, p.baseAssistantId] as const));
  const promptDisplay = (sha: string, label: string) =>
    promptAgentLabel(baseAgentName(promptBaseBySha.get(sha) ?? null), label);
  const set = (patch: Partial<Filters>) => onChange({ ...filters, ...patch });
  // Custom date range: flip to "custom" once BOTH dates are picked; keep partial entries otherwise.
  const applyDates = (from?: string, to?: string) =>
    from && to ? set({ range: "custom", from, to }) : set({ from, to });
  // Clearing the calendar returns to the 7d preset (the calendar owns its own open state now).
  const closeCustom = () =>
    set({ range: filters.range === "custom" ? "7d" : filters.range, from: undefined, to: undefined });
  const isDefault =
    filters.range === "7d" &&
    filters.campaignIds.length === 0 &&
    !filters.country &&
    !filters.prompt &&
    !filters.phone.trim();

  const countryOptions: DropdownOption[] = [
    { value: "", label: "All countries" },
    ...(data?.options.countries ?? []).map((c) => ({ value: c.value, label: c.label })),
  ];
  const promptOptions: DropdownOption[] = [
    { value: "", label: "All prompts" },
    ...(data?.options.prompts ?? []).map((p) => ({ value: p.sha, label: promptDisplay(p.sha, p.label) })),
  ];
  // Campaign labels: the server lists only in-window campaigns; campaignFilterLabels turns them
  // into the DE-BOILERPLATED short form and disambiguates what collides (sixty raw names all
  // opening "Daily Automated Conversion | VOIZO …" are unreadable in a dropdown — Val's CRM team,
  // 2026-08-26). Shared by the dropdown options AND the active chips, so they always agree.
  const rawCampaigns = data?.options.campaigns ?? [];
  const campaignLabelById = campaignFilterLabels(rawCampaigns);
  // Group headers get their labels from the PARENTS through the same disambiguator, because the
  // parent names collide too: the AU REACTIVATION parent exists once per brand under one name.
  const rawParents = data?.options.campaignParents ?? [];
  const parentLabels: Record<string, string> = Object.fromEntries(campaignGroupHeaderLabels(rawParents));
  // Searchable text = the visible label PLUS the raw name, so a keyword still finds a campaign by
  // something the short label drops ("voizo", "fortune", a date stamp) as well as by what's shown.
  // A child also matches on its PARENT's label, so searching "reactivation" still reaches the
  // children of a parent whose group is collapsed.
  const campaignOptions = rawCampaigns.map((c) => {
    const label = campaignLabelById.get(c.id)!;
    const parentLabel = c.parentId ? (parentLabels[c.parentId] ?? "") : "";
    return {
      value: c.id,
      label,
      search: `${label} ${parentLabel} ${c.name}`,
      parentId: c.parentId ?? null,
      runLabel: campaignRunLabel(c.name, c.startAt),
    };
  });
  const campaignName = (id: string) => campaignLabelById.get(id) ?? id;
  const promptLabelFor = (sha: string) => {
    const o = data?.options.prompts.find((p) => p.sha === sha);
    return o ? promptDisplay(o.sha, o.label) : sha.slice(0, 8);
  };

  // Active-filter chips.
  const chips: { key: string; label: string; onRemove: () => void }[] = [
    {
      key: "range",
      label: filters.range === "custom" && filters.from && filters.to ? `${filters.from} → ${filters.to}` : RANGE_LABEL[filters.range],
      onRemove: () => set({ range: "7d", from: undefined, to: undefined }),
    },
    // Past a handful, one chip for the lot. "Select all 30" used to lay eight rows of chips
    // across the bar and push the KPI cards off screen; nobody unpicks thirty campaigns one
    // chip at a time anyway — they reopen the dropdown, or clear the lot here.
    ...(filters.campaignIds.length > CHIP_LIST_MAX
      ? [{
          key: "campaigns",
          label: `${filters.campaignIds.length} campaigns`,
          onRemove: () => set({ campaignIds: [] }),
        }]
      : filters.campaignIds.map((id) => ({
          key: `c-${id}`,
          label: campaignName(id),
          onRemove: () => set({ campaignIds: filters.campaignIds.filter((x) => x !== id) }),
        }))),
    ...(filters.country ? [{ key: "country", label: `Country: ${filters.country}`, onRemove: () => set({ country: "" }) }] : []),
    ...(filters.prompt ? [{ key: "prompt", label: `Prompt: ${promptLabelFor(filters.prompt)}`, onRemove: () => set({ prompt: "" }) }] : []),
    ...(filters.phone.trim() ? [{ key: "phone", label: `Phone: ${filters.phone.trim()}`, onRemove: () => set({ phone: "" }) }] : []),
  ];

  const k = data?.kpis;
  // Reach is materially "estimated" when a big share of connects aren't yet evaluated for voicemail
  // (those count as reached). Voicemail detection is forward-only (~19 Jun), so long windows have low
  // coverage. Flag the "est" caveat below ~80% coverage — keeps the default 7d view (≈95%) clean.
  const reachCoverage = k && k.connected > 0 ? k.voicemailEvaluated / k.connected : 1;
  const reachEstimated = !!k && reachCoverage < 0.8;
  const phoneMatch = data?.phone?.query ? data.phone : null;
  // Friendly labels for the best-performer cards.
  const bestCampaign = data?.best.campaign
    ? { ...data.best.campaign, label: formatCampaign(data.best.campaign.label).display }
    : null;
  const bestAgent = data?.best.agent
    ? { ...data.best.agent, label: baseAgentName(data.best.agent.key) ?? data.best.agent.label }
    : null;
  // best.prompt.key is the prompt sha → resolve its base-agent name + compose with the snippet.
  const bestPrompt = data?.best.prompt
    ? { ...data.best.prompt, label: promptDisplay(data.best.prompt.key, data.best.prompt.label) }
    : null;
  // Brands represented in the range's campaigns (VOZ-216). options.campaigns IS the
  // in-window live set the KPIs aggregate, so this needs no second fetch.
  const rangeBrands = distinctBrandLabels((data?.options.campaigns ?? []).map((c) => c.brand));

  return (
    <section className="grid gap-4 min-w-0">
      {/* The panel (mockup, 2026-09-03): header, filter bar, connect-rate hero and the chart strip
          in ONE bordered island; Campaign Performance, the heat map and the leaderboards follow as
          their own cards. The rail's "Performance" anchor is this island. */}
      <SectionIsland id="global-performance">
      <div className="flex items-center gap-2.5 flex-wrap">
        <SectionTick color="#5b9bf0" />
        <h2 className="text-lg font-semibold tracking-tight">Global Performance</h2>
        <span className="text-[13px] text-[var(--text-3)]">
          {data ? `(historical · ${data.campaignCount} campaign${data.campaignCount === 1 ? "" : "s"})` : "(historical, across all campaigns)"}
        </span>
        {/* Brand scope of these KPIs (VOZ-216): the in-window campaigns the numbers
            are built from — so "whose performance is this?" needs no drill-down. */}
        {rangeBrands.length > 0 && (
          <span className="text-[13px] text-[var(--text-3)]">
            {rangeBrands.length === 1 ? "brand" : "brands"}:{" "}
            <span className="text-primary font-medium">{rangeBrands.join(" · ")}</span>
          </span>
        )}
        {/* Header right (mockup): the load state, Export, and the range presets. */}
        <div className="ml-auto flex items-center gap-2 flex-wrap">
          {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
          {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
          <GlobalExport filters={filters} scopeIds={brand ? rawCampaigns.map((c) => c.id) : null} disabled={!data} />
          <div className="inline-flex p-[3px] gap-0.5 rounded-[9px] bg-[var(--bg-elevated)] border border-[var(--border)]">
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => set({ range: r, from: undefined, to: undefined })}
                className={`px-2.5 py-1 rounded-md text-[12.5px] font-semibold font-mono transition ${
                  filters.range === r ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {RANGE_BTN[r] ?? r}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Filter bar (mockup order, 2026-09-03): search, campaigns, markets, prompts, Clear, then
          the window picker at the right. The range presets moved up to the header. Pinned under
          the section rail on desktop for as long as the panel is in view. */}
      <div className="sticky top-0 md:top-[52px] z-20 flex items-center gap-3 flex-wrap px-3.5 py-2.5 rounded-[13px] border border-[var(--border)] bg-[rgba(15,17,22,0.94)] backdrop-blur-md shadow-[0_6px_20px_rgba(0,0,0,0.25)]">
        <div className="relative min-w-[200px]">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-4)] pointer-events-none" />
          <input
            value={filters.phone}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="Search any called number…"
            aria-label="Search Global Performance by a called number"
            className="pl-8 pr-3 py-1.5 w-full text-[13px] rounded-[9px] bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none focus:border-primary transition"
          />
        </div>
        <CampaignPicker
          label="All campaigns"
          options={campaignOptions}
          parentLabels={parentLabels}
          selected={filters.campaignIds}
          onChange={(ids) => set({ campaignIds: ids })}
        />
        {/* Markets (mockup): the brand's own countries in this window, as tabs, All first. A
            market this brand does not dial is never offered, so a tab can never dead-end. */}
        <div role="tablist" aria-label="Markets" className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]">
          {countryOptions.map((o) => {
            const on = filters.country === o.value;
            return (
              <button
                key={o.value}
                type="button"
                role="tab"
                aria-selected={on}
                onClick={() => set({ country: o.value })}
                className={`px-2.5 py-1 rounded-md text-[11.5px] transition-colors ${on ? "bg-[var(--bg-card)] text-[var(--text-1)] shadow-sm" : "text-[var(--text-3)] hover:text-[var(--text-1)]"}`}
              >
                {o.value === "" ? "All markets" : o.label}
              </button>
            );
          })}
        </div>
        <div className="min-w-[150px]">
          <StyledSelect options={promptOptions} value={filters.prompt} onChange={(v) => set({ prompt: v })} placeholder="All prompts" />
        </div>
        {!isDefault && (
          <button
            onClick={() => onChange(DEFAULTS)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-[9px] border border-[var(--border)] text-[12.5px] text-[var(--text-3)] hover:text-[var(--text-1)] hover:border-[var(--border-2)] transition"
          >
            <X size={13} /> Clear
          </button>
        )}
        {/* Custom window: the same calendar Campaign Performance uses. An empty pair here means a
            preset is in charge, so the button reads "Pick a window", not "All time". */}
        <div className="ml-auto">
          <RangeCalendar
            from={filters.range === "custom" ? filters.from ?? "" : ""}
            to={filters.range === "custom" ? filters.to ?? "" : ""}
            runDates={(data?.options.campaigns ?? []).map((c) => (c.startAt ?? "").slice(0, 10)).filter(Boolean)}
            onApply={(f, t) => (f && t ? applyDates(f, t) : closeCustom())}
            ariaLabel="Pick a custom window"
            emptyLabel="Pick a window"
          />
        </div>
        {chips.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap w-full">
            {chips.map((c) => (
              <span key={c.key} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-2)] bg-[var(--bg-elevated)] border border-[var(--border)] rounded-full pl-2.5 pr-1.5 py-0.5">
                <span className="truncate max-w-[200px]">{c.label}</span>
                <button onClick={c.onRemove} className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors" aria-label={`Remove ${c.label}`}>
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Phone-lookup match banner (search feedback — sits with the filter bar, above the panel). */}
      {phoneMatch && (
        <div className="text-[12px] text-[var(--text-2)] bg-[var(--bg-elevated)] border border-[var(--border)] rounded-xl px-3.5 py-2.5">
          {phoneMatch.matchedCampaigns.length > 0 ? (
            <>
              <span className="text-[var(--text-3)]">Campaigns that called </span>
              <span className="font-mono text-[var(--text-1)]">{phoneMatch.query}</span>
              <span className="text-[var(--text-3)]">: </span>
              {phoneMatch.matchedCampaigns.map((c) => c.name).join(", ")}
            </>
          ) : (
            <>
              <span className="text-[var(--text-3)]">No campaign called </span>
              <span className="font-mono text-[var(--text-1)]">{phoneMatch.query}</span>
              <span className="text-[var(--text-3)]"> in this window.</span>
            </>
          )}
        </div>
      )}

      {/* Overview island (Jasiel 2026-07-03), now holding ONE thing (Jasiel 2026-09-02): the
          connect-rate hero. Gaining or losing, with outage days excluded from the comparison on
          both sides. The three PerformanceCards that lived here since Slice B duplicated Campaign
          Performance's summary below and were removed, as prod itself removed the KPI stat-band
          above them on 2026-07-08 for the same reason. The filter bar, leaderboards, charts,
          table and heatmap stay free-standing on the app background. */}
      {data ? (
        <ConnectRateHero
          trend={data.trend}
          baseline={data.baseline ?? null}
          rangeDays={data.rangeDays}
          todayIso={new Date().toISOString().slice(0, 10)}
          estimated={reachEstimated}
          noBaselineWhy={
            filters.range === "lifetime"
              ? "All time has no equal-length window before it."
              : filters.phone.trim()
                ? "A number search has no comparable window."
                : data.baseline === undefined
                  ? "This deployment's API does not return a baseline yet."
                  : undefined
          }
        />
      ) : (
        <CardGridSkeleton />
      )}

      {/* Four charts as ONE swipeable strip, two shown at a time (mockup, 2026-09-03): Activity
          Trend and Daily Call Volume as before, plus the Conversion Funnel (the stages the removed
          cards carried, as one shape) and Market Comparison (volume share vs connect rate per
          market). A four-up grid read as a wall; a strip keeps the row height and the reader's
          place. They stack on narrow screens. */}
      <ChartStrip count={4}>
        <TrendChart data={data?.trend ?? []} />
        <DailyVolumeChart data={data?.dailyVolume ?? { days: [], series: [] }} />
        <ConversionFunnel perf={data?.perf ?? null} connected={data?.kpis.connected ?? 0} rangeDays={data?.rangeDays ?? 0} />
        <MarketComparison markets={data?.markets ?? []} />
      </ChartStrip>
      </SectionIsland>

      {/* Campaign Performance — its own date range + status filters (independent of the bar above). */}
      {/* Page scope reaches the section: brand remounts it (its own filters start over, as the
          mockup resets them on a brand change); the market narrows its rows. */}
      <div id="sec-camps" className="scroll-mt-14">
        <CampaignTable key={brand} brand={brand} country={filters.country} />
      </div>

      <div id="sec-heat" className="scroll-mt-14">
        <HeatMap
          cells={data?.heatmap?.cells ?? []}
          utcFallbackCalls={data?.heatmap?.utcFallbackCalls ?? 0}
        />
      </div>

      {/* Leaderboards — ONE module for best campaign/agent/prompt (pattern brief §6): dimension
          switch + best-in-view highlight + ranked table; rows drill into the scoped drawer.
          Relocated to the bottom of the section + wrapped in a reused SectionIsland overview
          panel for parity with the rest (Jasiel 2026-07-03). */}
      <SectionIsland id="sec-lead">
        <Leaderboards
          campaigns={data?.campaigns ?? []}
          agents={data?.agents ?? []}
          prompts={data?.prompts ?? []}
          best={{ campaign: bestCampaign, agent: bestAgent, prompt: bestPrompt }}
          filters={filters}
        />
      </SectionIsland>
    </section>
  );
}
