"use client";

// Centered modal "metric report" behind every clickable dashboard KPI card (dashboard-metric-drilldown
// spec, Feature 2). A plain-language receipt + a region × time (today / yesterday / last-7d)
// breakdown — operator-first: a hero number, colored movement chips, and proportional mini-bars,
// no formulas. Fetches the aggregates-only /api/dashboard/metric-breakdown on open (once per open).

import { useEffect, useRef, useState } from "react";
import { X, PhoneCall, Zap, Trophy, MessageSquare } from "lucide-react";
import type { MetricBreakdown, RegionRow, BreakdownCell } from "@/lib/metricBreakdown";

export type MetricKey = "calls" | "connect" | "success" | "messages";

const META: Record<
  MetricKey,
  { label: string; subtitle: string; rate: boolean; accent: string; bar: string; icon: typeof PhoneCall; get: (c: BreakdownCell) => number | null }
> = {
  calls: {
    label: "Calls", subtitle: "Calls placed — by region & time", rate: false,
    accent: "text-[var(--text-1)]", bar: "bg-blue-400", icon: PhoneCall, get: (c) => c.calls,
  },
  connect: {
    label: "Connect rate", subtitle: "How often we reach someone — by region & time", rate: true,
    accent: "text-emerald-400", bar: "bg-emerald-400", icon: Zap, get: (c) => c.connectRate,
  },
  success: {
    label: "Success rate", subtitle: "How often we hit the goal — by region & time", rate: true,
    accent: "text-amber-400", bar: "bg-amber-400", icon: Trophy, get: (c) => c.successRate,
  },
  messages: {
    label: "Messages", subtitle: "Texts sent — by region & time", rate: false,
    accent: "text-sky-400", bar: "bg-sky-400", icon: MessageSquare, get: (c) => c.messages,
  },
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

// Colored movement chip comparing today to a baseline. Rates → percentage-point move; counts → absolute.
function DeltaChip({ metric, today, base, label }: { metric: MetricKey; today: number | null; base: number | null; label: string }) {
  if (today === null || base === null) {
    return <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">— vs {label}</span>;
  }
  const rate = META[metric].rate;
  const diff = today - base;
  const flatEps = rate ? 0.0005 : 0.5;
  if (Math.abs(diff) < flatEps) {
    return <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">▬ flat vs {label}</span>;
  }
  const up = diff > 0;
  const mag = rate ? `${Math.abs(diff * 100).toFixed(1)} pts` : Math.abs(diff).toLocaleString();
  const cls = up ? "bg-emerald-500/12 text-emerald-400" : "bg-red-500/12 text-red-400";
  return (
    <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${cls}`}>
      {up ? "▲" : "▼"} {mag} vs {label}
    </span>
  );
}

// One window's value + a proportional bar. `frac` is the 0..1 fill (caller normalizes).
function Bar({ label, value, frac, barCls, emphasize }: { label: string; value: string; frac: number; barCls: string; emphasize: boolean }) {
  return (
    <div className="grid grid-cols-[68px_1fr_auto] items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">{label}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-[var(--bg-elevated)]">
        <span className={`block h-full rounded-full ${barCls} ${emphasize ? "" : "opacity-40"}`} style={{ width: `${Math.max(frac * 100, frac > 0 ? 3 : 0)}%` }} />
      </span>
      <span className={`font-mono text-xs ${emphasize ? "text-[var(--text-1)] font-semibold" : "text-[var(--text-2)]"}`}>{value}</span>
    </div>
  );
}

const WINDOWS: { key: "today" | "yesterday" | "last7d"; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "last7d", label: "Last 7d" },
];

function RegionTile({ metric, row }: { metric: MetricKey; row: RegionRow }) {
  const m = META[metric];
  const g = m.get;
  // Bar fill: rates use the rate directly (0..1); counts normalize by the row's busiest window.
  const vals = WINDOWS.map((w) => g(row[w.key]) ?? 0);
  const denom = m.rate ? 1 : Math.max(...vals, 1);
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-3">
      <div className="mb-2 flex items-center justify-between">
        <span className="rounded-md bg-[var(--bg-elevated)] px-1.5 py-0.5 text-[11px] font-bold tracking-wide text-[var(--text-2)]">
          {row.region === "ALL" ? "ALL" : row.region === "UNKNOWN" ? "Other" : row.region}
        </span>
        <DeltaChip metric={metric} today={g(row.today)} base={g(row.yesterday)} label="yest." />
      </div>
      <div className="grid gap-1.5">
        {WINDOWS.map((w) => (
          <Bar
            key={w.key}
            label={w.label}
            value={fmt(metric, g(row[w.key]))}
            frac={(g(row[w.key]) ?? 0) / denom}
            barCls={m.bar}
            emphasize={w.key === "today"}
          />
        ))}
      </div>
    </div>
  );
}

export default function MetricDrawer({ metric, onClose }: { metric: MetricKey | null; onClose: () => void }) {
  const [data, setData] = useState<MetricBreakdown | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = metric !== null;
  // Derived, not stored — avoids syncing a loading flag to the `open` prop inside the effect.
  // First open (no data, no error) shows the loader; a re-open keeps the cached breakdown visible.
  const loading = open && data === null && error === null;
  // Latest onClose without re-subscribing each parent render. The dashboard polls every 30s, so a
  // changing-callback dependency would re-fire the effect and refetch the open drawer every tick.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Fetch the breakdown ONCE per open. The data is metric-independent (the same region×time
  // aggregate feeds every card), so switching cards while open reuses it — no refetch.
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    fetch("/api/dashboard/metric-breakdown", { cache: "no-store", signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((j: MetricBreakdown) => { setData(j); setError(null); })
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError(e instanceof Error ? e.message : "Failed to load");
      });
    return () => controller.abort();
  }, [open]);

  // Close on Escape (onClose via ref → no re-subscribe on parent re-renders).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!metric) return null;
  const m = META[metric];
  const Icon = m.icon;
  const total = data?.total;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={`${m.label} breakdown`}>
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative flex max-h-[85vh] w-full max-w-lg flex-col rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] shadow-2xl">
        {/* Header — icon + title + subtitle, mirrors the prompt modal's chrome. */}
        <div className="flex items-start justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-2 text-sm font-semibold text-[var(--text-1)]">
              <Icon size={15} className={m.accent} /> {m.label}
            </span>
            <p className="mt-1 text-[11px] text-[var(--text-3)]">{m.subtitle}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="shrink-0 text-[var(--text-3)] transition-colors hover:text-[var(--text-1)]">
            <X size={18} />
          </button>
        </div>

        <div className="grid min-h-0 gap-4 overflow-y-auto p-5">
          {loading && <p className="py-10 text-center text-xs text-[var(--text-3)]">Loading breakdown…</p>}
          {error && <p className="py-10 text-center text-xs text-amber-400">Couldn&apos;t load this breakdown ({error}).</p>}

          {total ? (
            <>
              {/* Hero — the one bold moment: today's number, the receipt, and how it moved. */}
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5">
                <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Today · all regions</div>
                <div className={`mt-1 font-mono text-[40px] font-bold leading-none ${m.accent}`}>{fmt(metric, m.get(total.today))}</div>
                <div className="mt-2 text-xs text-[var(--text-2)]">{receipt(metric, total.today)}</div>
                <div className="mt-3 flex flex-wrap gap-1.5">
                  <DeltaChip metric={metric} today={m.get(total.today)} base={m.get(total.yesterday)} label="yesterday" />
                  {m.rate ? (
                    <DeltaChip metric={metric} today={m.get(total.today)} base={m.get(total.last7d)} label="last 7d" />
                  ) : (
                    <span className="rounded-full bg-[var(--bg-elevated)] px-2 py-0.5 text-[10px] text-[var(--text-3)]">
                      {fmt(metric, m.get(total.last7d))} in last 7d
                    </span>
                  )}
                </div>
              </div>

              {/* By region — proportional mini-bars across the three windows. */}
              <div>
                <div className="mb-2 text-[10px] uppercase tracking-wider text-[var(--text-3)]">By region</div>
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
          ) : null}
        </div>
      </div>
    </div>
  );
}
