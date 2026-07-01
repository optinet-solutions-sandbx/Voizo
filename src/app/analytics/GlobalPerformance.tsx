"use client";

// Global Performance section (Val's spec). Slice 2: filter scope banner + the full
// filter bar (date range · campaigns multi · agent · prompt · phone-lookup + match
// banner · removable chips · Clear) driving the 6-card KPI grid. Prompt is disabled
// until the prompt-attribution slice. Data: /api/dashboard/analytics.
// Connect = ANSWER (incl. voicemail); Success% = goal/connected. Ghost+test excluded.

import { useCallback, useEffect, useRef, useState } from "react";
import { Search, X } from "lucide-react";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import { formatCampaign, promptAgentLabel } from "@/lib/campaignDisplay";
import { useBaseAgentNames } from "./useBaseAgentNames";
import RankedTables, { type AgentRow, type CampaignLbRow, type PromptRow } from "./RankedTables";
import CampaignTable from "./CampaignTable";
import TrendChart from "./TrendChart";
import DailyVolumeChart from "./DailyVolumeChart";
import HeatMap from "./HeatMap";
import PerformanceCards from "./PerformanceCards";
import TopPerformers from "./TopPerformers";
import RangedRecordsDrawer, { type DrawerFilter, totalFilter, rowFilter } from "./RangedRecordsDrawer";
import type { TrendPoint, VolumeResult, HeatmapResult, TodayPerfDay, PerfRow } from "@/lib/dashboardAnalytics";

type RangeKey = "7d" | "14d" | "30d" | "60d" | "90d";
const RANGES: RangeKey[] = ["7d", "14d", "30d", "60d", "90d"];
const RANGE_LABEL: Record<RangeKey, string> = { "7d": "Last 7 days", "14d": "Last 14 days", "30d": "Last 30 days", "60d": "Last 60 days", "90d": "Last 90 days" };

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
  dailyVolume: VolumeResult;
  heatmap: HeatmapResult;
  options: {
    campaigns: { id: string; name: string }[];
    agents: { voiceId: string; label: string | null }[];
    prompts: { sha: string; label: string; baseAssistantId: string | null }[];
  };
  phone: { query: string | null; matchedCampaigns: { id: string; name: string }[] };
}

export interface Filters {
  range: RangeKey;
  campaignIds: string[];
  agent: string; // "" = all
  prompt: string; // "" = all (prompt sha)
  phone: string;
}
// Default 7d (Val 2026-06-26): reach-based metrics (Reached, Positive Response) are only
// fully accurate post voicemail-detection deploy (~19 Jun) — a 7d default keeps them honest.
export const DEFAULTS: Filters = { range: "7d", campaignIds: [], agent: "", prompt: "", phone: "" };

interface GlobalPerformanceProps {
  // Controlled by DashboardView (lifted 2026-06-16) so both the running cards and the leaderboard
  // can drive "Filter to this campaign" through the same filter state.
  filters: Filters;
  onChange: (next: Filters) => void;
  onFocusCampaign: (id: string) => void; // set campaignIds=[id] + scroll to this section
}

function buildQuery(f: Filters): string {
  const p = new URLSearchParams();
  p.set("range", f.range);
  if (f.campaignIds.length) p.set("campaigns", f.campaignIds.join(","));
  if (f.agent) p.set("agent", f.agent);
  if (f.prompt) p.set("prompt", f.prompt);
  if (f.phone.trim()) p.set("phone", f.phone.trim());
  return p.toString();
}

// Trigger/panel styling mirrors StyledSelect so the bar is visually uniform.
const TRIGGER_CLS =
  "w-full flex items-center justify-between gap-2 pl-3.5 pr-3 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-sm text-left hover:border-blue-500/40 transition-all cursor-pointer";

function MultiSelect({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const text = selected.length === 0 ? label : `${selected.length} selected`;
  return (
    <div ref={ref} className="relative min-w-[170px]">
      <button type="button" onClick={() => setOpen(!open)} className={TRIGGER_CLS}>
        <span className={selected.length ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}>{text}</span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-[var(--text-3)] transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        <div className="absolute z-50 mt-1.5 w-[max(100%,240px)] max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
          {options.length === 0 ? (
            <div className="px-3.5 py-2.5 text-xs text-[var(--text-3)]">No campaigns</div>
          ) : (
            options.map((o) => {
              const on = selected.includes(o.value);
              return (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => toggle(o.value)}
                  className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors"
                >
                  <span className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${on ? "bg-blue-600 border-blue-600 text-white" : "border-[var(--border-2)]"}`}>
                    {on && (
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 6 9 17l-5-5" />
                      </svg>
                    )}
                  </span>
                  <span className="truncate">{o.label}</span>
                </button>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// Compact "estimated" pill — shown on reach-derived cards when the window includes connects
// not yet evaluated for voicemail (those count as reached, inflating reach / diluting positive rate).
function EstBadge({ title }: { title: string }) {
  return (
    <span
      title={title}
      className="text-[8.5px] font-semibold uppercase tracking-wider text-amber-400/90 border border-amber-400/30 rounded px-1 py-px leading-none cursor-help"
    >
      est
    </span>
  );
}

export default function GlobalPerformance({ filters, onChange, onFocusCampaign }: GlobalPerformanceProps) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  // Drill-down: a clicked card total/row/sub-row opens the ranged records drawer for that slice.
  const [drawerFilter, setDrawerFilter] = useState<DrawerFilter | null>(null);
  // Re-clicking the open slice closes the drawer (toggle); status+outcome+smsOnly identify a slice.
  const sameSlice = (a: DrawerFilter | null, b: DrawerFilter) =>
    !!a && a.status === b.status && a.outcome === b.outcome && a.smsOnly === b.smsOnly;
  const openTotal = (card: "callAttempts" | "reached" | "sms") =>
    setDrawerFilter((prev) => { const next = totalFilter(card); return sameSlice(prev, next) ? null : next; });
  const openRow = (card: "callAttempts" | "reached" | "sms", row: PerfRow) =>
    setDrawerFilter((prev) => { const next = rowFilter(card, row.key, row.label); return sameSlice(prev, next) ? null : next; });

  const load = useCallback(async (query: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/analytics?${query}`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as AnalyticsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  const query = buildQuery(filters);
  useEffect(() => {
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
  const isDefault =
    filters.range === "7d" &&
    filters.campaignIds.length === 0 &&
    !filters.agent &&
    !filters.prompt &&
    !filters.phone.trim();

  const agentOptions: DropdownOption[] = [
    { value: "", label: "All agents" },
    ...(data?.options.agents ?? []).map((a) => ({ value: a.voiceId, label: a.label ?? a.voiceId })),
  ];
  const promptOptions: DropdownOption[] = [
    { value: "", label: "All prompts" },
    ...(data?.options.prompts ?? []).map((p) => ({ value: p.sha, label: promptDisplay(p.sha, p.label) })),
  ];
  const campaignOptions = (data?.options.campaigns ?? []).map((c) => ({ value: c.id, label: c.name }));
  const campaignName = (id: string) => data?.options.campaigns.find((c) => c.id === id)?.name ?? id;
  const agentLabel = (id: string) => data?.options.agents.find((a) => a.voiceId === id)?.label ?? id;
  const promptLabelFor = (sha: string) => {
    const o = data?.options.prompts.find((p) => p.sha === sha);
    return o ? promptDisplay(o.sha, o.label) : sha.slice(0, 8);
  };

  // Active-filter chips.
  const chips: { key: string; label: string; onRemove: () => void }[] = [
    { key: "range", label: RANGE_LABEL[filters.range], onRemove: () => set({ range: "7d" }) },
    ...filters.campaignIds.map((id) => ({
      key: `c-${id}`,
      label: campaignName(id),
      onRemove: () => set({ campaignIds: filters.campaignIds.filter((x) => x !== id) }),
    })),
    ...(filters.agent ? [{ key: "agent", label: `Agent: ${agentLabel(filters.agent)}`, onRemove: () => set({ agent: "" }) }] : []),
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

  return (
    <section id="global-performance" className="grid gap-4 scroll-mt-4">
      <div className="pt-2">
        <h2 className="text-[20px] font-bold tracking-tight">Global Performance</h2>
        <p className="text-sm text-[var(--text-3)] mt-1">Historical performance across all campaigns.</p>
      </div>

      {/* Filter bar. */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <div className="inline-flex rounded-xl border border-[var(--border)] overflow-hidden">
          {RANGES.map((r) => (
            <button
              key={r}
              onClick={() => set({ range: r })}
              className={`px-3.5 py-2.5 text-xs font-medium transition ${
                filters.range === r ? "bg-blue-600 text-white" : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {r}
            </button>
          ))}
        </div>

        <MultiSelect
          label="All campaigns"
          options={campaignOptions}
          selected={filters.campaignIds}
          onChange={(ids) => set({ campaignIds: ids })}
        />

        <div className="min-w-[150px]">
          <StyledSelect options={agentOptions} value={filters.agent} onChange={(v) => set({ agent: v })} placeholder="All agents" />
        </div>

        <div className="min-w-[150px]">
          <StyledSelect options={promptOptions} value={filters.prompt} onChange={(v) => set({ prompt: v })} placeholder="All prompts" />
        </div>

        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
          <input
            value={filters.phone}
            onChange={(e) => set({ phone: e.target.value })}
            placeholder="Search any called number…"
            className="pl-8 pr-3 py-2.5 w-[210px] text-sm rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500 transition-all"
          />
        </div>

        {!isDefault && (
          <button
            onClick={() => onChange(DEFAULTS)}
            className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-3 py-2.5 rounded-xl border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition"
          >
            Clear filters
          </button>
        )}
        {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
        {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
      </div>

      {/* Removable chips. */}
      {chips.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap -mt-1">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-2)] bg-[var(--bg-elevated)] border border-[var(--border)] rounded-full pl-2.5 pr-1.5 py-1">
              <span className="truncate max-w-[200px]">{c.label}</span>
              <button onClick={c.onRemove} className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors" aria-label={`Remove ${c.label}`}>
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Phone-lookup match banner. */}
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

      {/* Ranged 3-card Performance (Val's mockup, Slice B) — replaces the old 5-card KPI strip.
          NO deltas (mockup intent for Global). The Connect/Reached/Voicemail/Positive metrics now
          live as breakdown ROWS inside the cards. `est` note when voicemail coverage is low on long
          windows (forward-only detection). Drill-down drawer is wired in the next step. */}
      {data?.perf ? (
        <div className="grid gap-2">
          {reachEstimated && (
            <p className="text-[11px] text-[var(--text-3)] flex items-center gap-1.5">
              <EstBadge title="Estimated — long windows include connects not yet evaluated for voicemail (forward-only from ~19 Jun), which count as reached." />
              Reached-based splits are best-effort over this window; early-hang-up vs neutral is approximate (no transcript scan).
            </p>
          )}
          <PerformanceCards perf={data.perf} showDeltas={false} onOpenTotal={openTotal} onOpenRow={openRow} />
          <RangedRecordsDrawer filters={filters} filter={drawerFilter} onClose={() => setDrawerFilter(null)} />
        </div>
      ) : data ? (
        <p className="text-center text-xs text-[var(--text-3)] py-8">Performance breakdown unavailable for this filter.</p>
      ) : (
        <p className="text-center text-xs text-[var(--text-3)] py-8">Loading…</p>
      )}

      {/* Top Performers — per-entity breakdown cards with per-row drill-down (Val's mockup, Slice E).
          Labels resolved here (campaign/agent/prompt) so the card uses the same friendly text as before. */}
      <TopPerformers best={{ campaign: bestCampaign, agent: bestAgent, prompt: bestPrompt }} filters={filters} />

      {/* Trend + Daily Volume side-by-side (compact); they stack on narrow screens. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <TrendChart data={data?.trend ?? []} />
        <DailyVolumeChart data={data?.dailyVolume ?? { days: [], series: [] }} />
      </div>

      {/* Campaign Performance — its own date range + status filters (independent of the bar above). */}
      <CampaignTable />

      <HeatMap
        cells={data?.heatmap?.cells ?? []}
        utcFallbackCalls={data?.heatmap?.utcFallbackCalls ?? 0}
      />

      {/* Voice Agent / Prompt performance + Top campaigns leaderboard. */}
      <RankedTables
        agents={data?.agents ?? []}
        campaigns={data?.campaigns ?? []}
        prompts={data?.prompts ?? []}
        rangeDays={data?.rangeDays ?? 30}
        onFocusCampaign={onFocusCampaign}
      />
    </section>
  );
}
