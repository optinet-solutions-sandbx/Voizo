"use client";

// Global Performance section (Val's spec). Slice 2: filter scope banner + the full
// filter bar (date range · campaigns multi · agent · prompt · phone-lookup + match
// banner · removable chips · Clear) driving the 6-card KPI grid. Prompt is disabled
// until the prompt-attribution slice. Data: /api/dashboard/analytics.
// Connect = ANSWER (incl. voicemail); Success% = goal/connected. Ghost+test excluded.

import { useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { Phone, Zap, CheckCircle2, Trophy, Mic, FileText, Search, X, UserCheck, Voicemail } from "lucide-react";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import { formatCampaign, promptAgentLabel } from "@/lib/campaignDisplay";
import { useMagnetic } from "@/components/useMagnetic";
import { useBaseAgentNames } from "./useBaseAgentNames";
import RankedTables, { type AgentRow, type CampaignLbRow, type PromptRow } from "./RankedTables";
import CampaignTable from "./CampaignTable";
import TrendChart from "./TrendChart";
import DailyVolumeChart from "./DailyVolumeChart";
import { type MetricKey } from "./MetricDrawer";
import HeatMap from "./HeatMap";
import type { TrendPoint, VolumeResult, HeatmapResult } from "@/lib/dashboardAnalytics";

type RangeKey = "7d" | "14d" | "30d" | "60d" | "90d";
const RANGES: RangeKey[] = ["7d", "14d", "30d", "60d", "90d"];
const RANGE_LABEL: Record<RangeKey, string> = { "7d": "Last 7 days", "14d": "Last 14 days", "30d": "Last 30 days", "60d": "Last 60 days", "90d": "Last 90 days" };

interface BestPerformer {
  key: string;
  label: string;
  positiveResponseRate: number;
  calls: number;
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
export const DEFAULTS: Filters = { range: "30d", campaignIds: [], agent: "", prompt: "", phone: "" };

interface GlobalPerformanceProps {
  // Controlled by DashboardView (lifted 2026-06-16) so both the running cards and the leaderboard
  // can drive "Filter to this campaign" through the same filter state.
  filters: Filters;
  onChange: (next: Filters) => void;
  onFocusCampaign: (id: string) => void; // set campaignIds=[id] + scroll to this section
  onMetricClick?: (m: MetricKey) => void; // open the metric drill-down drawer (state lifted to DashboardView)
}

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

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

function KpiCard({
  icon,
  label,
  value,
  valueColor = "text-[var(--text-1)]",
  sub,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  valueColor?: string;
  sub: ReactNode;
  onClick?: () => void;
}) {
  const magnetRef = useMagnetic<HTMLDivElement>();
  // Interactive props spread only when clickable (correct ARIA button pattern; inert div otherwise).
  const interactive = onClick
    ? {
        onClick,
        role: "button" as const,
        tabIndex: 0,
        title: "Click for the full breakdown",
        onKeyDown: (e: ReactKeyboardEvent) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
        },
      }
    : {};
  return (
    <div
      ref={magnetRef}
      {...interactive}
      className={`glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 ${onClick ? "cursor-pointer transition-colors hover:border-[var(--border-2)] focus:outline-none focus:ring-2 focus:ring-blue-500/40" : ""}`}
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</span>
        <span className="text-[var(--text-3)]">{icon}</span>
      </div>
      <div className={`text-[34px] leading-none font-bold font-mono mt-3 ${valueColor}`}>{value}</div>
      <div className="text-[11px] text-[var(--text-3)] mt-2">{sub}</div>
    </div>
  );
}

function BestCard({
  icon,
  label,
  best,
  accent,
}: {
  icon: ReactNode;
  label: string;
  best: BestPerformer | null;
  accent: string;
}) {
  const magnetRef = useMagnetic<HTMLDivElement>();
  return (
    <div
      ref={magnetRef}
      className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5"
    >
      <div className="flex items-center justify-between">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</span>
        <span className="text-[var(--text-3)]">{icon}</span>
      </div>
      {best ? (
        <>
          <div className={`text-lg font-semibold mt-3 truncate ${accent}`} title={best.label}>
            {best.label}
          </div>
          <div className="text-[11px] text-[var(--text-3)] mt-1">
            <span className="text-[var(--text-2)] font-medium">{pct(best.positiveResponseRate)} positive response</span> ·{" "}
            {best.calls.toLocaleString()} calls
          </div>
        </>
      ) : (
        <div className="text-sm text-[var(--text-3)] mt-3">Not enough call volume to rank yet</div>
      )}
    </div>
  );
}

export default function GlobalPerformance({ filters, onChange, onFocusCampaign, onMetricClick }: GlobalPerformanceProps) {
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
    filters.range === "30d" &&
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
    { key: "range", label: RANGE_LABEL[filters.range], onRemove: () => set({ range: "30d" }) },
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

      {/* KPI grid — Row 1 totals. Connected vs Reached are now distinct cards (Val 2026-06-26):
          "connected" = answered (incl. voicemail); "reached" = a live human picked up. */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3.5">
        <KpiCard
          onClick={() => onMetricClick?.("calls")}
          icon={<Phone size={14} />}
          label="Total Calls"
          value={(k?.calls ?? 0).toLocaleString()}
          sub={data ? `across ${data.campaignCount} campaign${data.campaignCount === 1 ? "" : "s"} · last ${data.rangeDays}d` : "—"}
        />
        <KpiCard
          onClick={() => onMetricClick?.("connect")}
          icon={<Zap size={14} />}
          label="Connect Rate"
          valueColor="text-emerald-400"
          value={pct(k?.connectRate ?? null)}
          sub={
            <span title="Connected = answered, including voicemail. A human pickup is shown separately as Reached.">
              {k ? `${k.connected.toLocaleString()} of ${k.terminal.toLocaleString()} calls connected` : "—"}
            </span>
          }
        />
        <KpiCard
          icon={<UserCheck size={14} />}
          label="Reached"
          valueColor="text-teal-400"
          value={(k?.reach ?? 0).toLocaleString()}
          sub={
            <span title="Live humans who picked up = connected − detected voicemails. Unevaluated connects count as reached (older data).">
              {k ? "live humans reached" : "—"}
            </span>
          }
        />
        <KpiCard
          icon={<Voicemail size={14} />}
          label="Voicemail"
          valueColor="text-violet-300"
          value={k && k.voicemailEvaluated > 0 ? pct(k.voicemailRate) : "—"}
          sub={
            <span title="Share of evaluated connects that resolved to the player's voicemail. Fills forward from the call-observability deploy.">
              {k && k.voicemailEvaluated > 0 ? "of evaluated connects" : "tracking from deploy"}
            </span>
          }
        />
        <KpiCard
          onClick={() => onMetricClick?.("success")}
          icon={<CheckCircle2 size={14} />}
          label="Positive Response Rate"
          valueColor="text-amber-400"
          value={pct(k?.positiveResponseRate ?? null)}
          sub={
            <span title="Players who agreed to receive the offer SMS (goal reached) ÷ humans reached. NOT a confirmed sale — real success (deposit/login) isn't visible yet.">
              {k ? `${k.successful.toLocaleString()} positive of ${k.reach.toLocaleString()} reached` : "—"}
            </span>
          }
        />
      </div>

      {/* KPI grid — Row 2 best performers (min-volume gated). */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5">
        <BestCard icon={<Trophy size={14} />} label="Best Campaign" best={bestCampaign} accent="text-[var(--text-1)]" />
        <BestCard icon={<Mic size={14} />} label="Best Voice Agent" best={bestAgent} accent="text-blue-400" />
        <BestCard icon={<FileText size={14} />} label="Best Prompt" best={bestPrompt} accent="text-amber-300" />
      </div>

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
