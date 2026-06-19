"use client";

// Slide-over "metric report" behind every clickable dashboard KPI card (dashboard-metric-drilldown
// spec, Feature 2). Plain-language receipt at the top, then a region × time (today / yesterday /
// last-7d) breakdown with indicators — operator-first, no formulas. Fetches the aggregates-only
// /api/dashboard/metric-breakdown on open (once per open), so it adds no cost to the dashboard.

import { useEffect, useState } from "react";
import { X, PhoneCall, Zap, Trophy, MessageSquare } from "lucide-react";
import type { MetricBreakdown, RegionRow, BreakdownCell } from "@/lib/metricBreakdown";

export type MetricKey = "calls" | "connect" | "success" | "messages";

const META: Record<
  MetricKey,
  { label: string; rate: boolean; accent: string; icon: typeof PhoneCall; get: (c: BreakdownCell) => number | null }
> = {
  calls: { label: "Calls", rate: false, accent: "text-[var(--text-1)]", icon: PhoneCall, get: (c) => c.calls },
  connect: { label: "Connect rate", rate: true, accent: "text-emerald-400", icon: Zap, get: (c) => c.connectRate },
  success: { label: "Success rate", rate: true, accent: "text-amber-400", icon: Trophy, get: (c) => c.successRate },
  messages: { label: "Messages", rate: false, accent: "text-sky-400", icon: MessageSquare, get: (c) => c.messages },
};

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const num = (v: number | null) => (v === null ? "—" : v.toLocaleString());
const fmt = (metric: MetricKey, v: number | null) => (META[metric].rate ? pct(v) : num(v));

// Plain-language "receipt" for a window's cell — counts, never a formula.
function receipt(metric: MetricKey, c: BreakdownCell): string {
  switch (metric) {
    case "calls":
      return `${c.calls.toLocaleString()} calls placed`;
    case "connect":
      return `${c.connected.toLocaleString()} of ${c.calls.toLocaleString()} calls reached someone`;
    case "success":
      return `${c.goals.toLocaleString()} of ${c.connected.toLocaleString()} connected calls hit the goal`;
    case "messages":
      return `${c.messages.toLocaleString()} texts sent`;
  }
}

// Indicator comparing today to a baseline. Rates → percentage-point move; counts → absolute move.
function Delta({ metric, today, base, label }: { metric: MetricKey; today: number | null; base: number | null; label: string }) {
  if (today === null || base === null) {
    return <span className="text-[var(--text-3)]">— vs {label}</span>;
  }
  const rate = META[metric].rate;
  const diff = today - base;
  const flatEps = rate ? 0.0005 : 0.5;
  if (Math.abs(diff) < flatEps) return <span className="text-[var(--text-3)]">▬ flat vs {label}</span>;
  const up = diff > 0;
  const mag = rate ? `${Math.abs(diff * 100).toFixed(1)} pts` : Math.abs(diff).toLocaleString();
  return (
    <span className={up ? "text-emerald-400" : "text-red-400"}>
      {up ? "▲" : "▼"} {mag} vs {label}
    </span>
  );
}

function RegionTile({ metric, row }: { metric: MetricKey; row: RegionRow }) {
  const g = META[metric].get;
  const cols: { key: "today" | "yesterday" | "last7d"; label: string }[] = [
    { key: "today", label: "Today" },
    { key: "yesterday", label: "Yesterday" },
    { key: "last7d", label: "Last 7d" },
  ];
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-[var(--text-1)]">
          {row.region === "ALL" ? "All regions" : row.region === "UNKNOWN" ? "Other" : row.region}
        </span>
        <Delta metric={metric} today={g(row.today)} base={g(row.yesterday)} label="yest." />
      </div>
      <div className="mt-2 grid grid-cols-3 gap-2">
        {cols.map((c) => (
          <div key={c.key}>
            <div className={`font-mono text-base font-bold leading-tight ${c.key === "today" ? META[metric].accent : "text-[var(--text-2)]"}`}>
              {fmt(metric, g(row[c.key]))}
            </div>
            <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">{c.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function MetricDrawer({ metric, onClose }: { metric: MetricKey | null; onClose: () => void }) {
  const [data, setData] = useState<MetricBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Fetch once per open. Close on Escape.
  useEffect(() => {
    if (!metric) return;
    let cancelled = false;
    setData(null);
    setError(null);
    setLoading(true);
    fetch("/api/dashboard/metric-breakdown", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: MetricBreakdown) => {
        if (!cancelled) setData(j);
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      cancelled = true;
      window.removeEventListener("keydown", onKey);
    };
  }, [metric, onClose]);

  if (!metric) return null;
  const m = META[metric];
  const Icon = m.icon;
  const total = data?.total;

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`${m.label} breakdown`}>
      {/* Backdrop */}
      <button type="button" aria-label="Close" onClick={onClose} className="absolute inset-0 bg-black/50 backdrop-blur-[1px]" />
      {/* Panel */}
      <div className="relative h-full w-full max-w-md overflow-y-auto bg-[var(--bg-app)] border-l border-[var(--border)] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--border)] bg-[var(--bg-app)] px-5 py-4">
          <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-1)]">
            <Icon size={15} className="text-[var(--text-3)]" /> {m.label}
          </span>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--text-3)] transition hover:text-[var(--text-1)]">
            <X size={16} />
          </button>
        </div>

        <div className="grid gap-4 p-5">
          {loading && <p className="py-8 text-center text-xs text-[var(--text-3)]">Loading breakdown…</p>}
          {error && <p className="py-8 text-center text-xs text-amber-400">Couldn&apos;t load this breakdown ({error}).</p>}

          {total && (
            <>
              {/* Headline receipt — plain language, today + how it moved. */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-4">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Today</div>
                <div className={`mt-0.5 font-mono text-3xl font-bold leading-tight ${m.accent}`}>{fmt(metric, m.get(total.today))}</div>
                <div className="mt-1 text-xs text-[var(--text-2)]">{receipt(metric, total.today)}</div>
                <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
                  <Delta metric={metric} today={m.get(total.today)} base={m.get(total.yesterday)} label="yesterday" />
                  {m.rate && <Delta metric={metric} today={m.get(total.today)} base={m.get(total.last7d)} label="last 7d" />}
                </div>
              </div>

              {/* By region. */}
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-3)]">By region · today / yesterday / last 7d</div>
                <div className="grid gap-2">
                  {data!.regions.length === 0 ? (
                    <p className="py-4 text-center text-xs text-[var(--text-3)]">No activity in this window.</p>
                  ) : (
                    data!.regions.map((r) => <RegionTile key={r.region} metric={metric} row={r} />)
                  )}
                </div>
              </div>

              <p className="text-[10px] leading-relaxed text-[var(--text-3)]">
                Connected = a call that reached someone (includes voicemail). Ghost &amp; test campaigns are
                excluded. Today &amp; yesterday are UTC days; &ldquo;last 7d&rdquo; is the rolling week.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
