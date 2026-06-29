"use client";

// Today's Performance — 3-card redesign (Val's "endgame dashboard" mockup, 2026-06-29). Replaces
// the old 6-cell ops strip. Three cards (Call Attempts / Reached / SMS Sent), a Today/Yesterday
// toggle, dual deltas (vs-yesterday %, vs-7d-avg) on totals + rows, and EVERY total/row/sub-row
// clickable → an inline records drawer pre-filtered to that slice (the literal "real data"). Proxy
// outcome rows carry an "estimated" marker. Colors follow the mockup. Data: TodaySnapshot.today /
// .yesterday from /api/dashboard/today (computeTodayPerf).

import { useMemo, useState } from "react";
import { Radio } from "lucide-react";
import type { TodaySnapshot, TodayPerfDay, PerfMetric, PerfRow } from "@/lib/dashboardAnalytics";
import TodayRecordsDrawer, { type DrawerFilter } from "./TodayRecordsDrawer";

// Row accent colors — match Val's mockup (vivid bars/dots, distinct from the muted records chips).
const ROW_COLOR: Record<string, string> = {
  reached: "#1baf7a",
  voicemail: "#9085e9",
  unreachable: "#eda100",
  positive: "#1baf7a",
  neutral: "#4a9eed",
  declined: "#e34948",
  early_hangup: "#e06530",
};

const pctText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`);
const ppText = (v: number | null) => (v === null ? null : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`);

function deltaCls(v: number | null): string {
  if (v === null || Math.abs(v) < 0.0005) return "text-[var(--text-3)]";
  return v > 0 ? "text-emerald-400" : "text-red-400";
}

// Two small delta chips (vs yesterday, vs 7-day avg). `fmt` = pctText (totals) or ppText (rows).
function DeltaChips({ a, b, fmt }: { a: number | null; b: number | null; fmt: (v: number | null) => string | null }) {
  const ta = fmt(a);
  const tb = fmt(b);
  return (
    <span className="inline-flex items-center gap-1.5 text-[10px] font-medium">
      <span className={deltaCls(a)} title="vs yesterday">{ta ?? "—"}</span>
      <span className="text-[var(--border-2)]">·</span>
      <span className={deltaCls(b)} title="vs last 7-day average">{tb ?? "—"}</span>
    </span>
  );
}

function Pill({ pct, color }: { pct: number | null; color: string }) {
  return (
    <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded-full" style={{ background: `${color}1f`, color }}>
      {pct === null ? "—" : `${(pct * 100).toFixed(1)}%`}
    </span>
  );
}

function Bar({ pct, color }: { pct: number | null; color: string }) {
  const w = pct === null ? 0 : Math.max(pct * 100, pct > 0 ? 2 : 0);
  return (
    <span className="block h-[3px] rounded-full bg-[var(--bg-elevated)] overflow-hidden">
      <span className="block h-full rounded-full" style={{ width: `${w}%`, background: color }} />
    </span>
  );
}

// One breakdown row: label + count + pct pill + dual pp-deltas, a mini-bar, clickable → drawer.
// `indent` renders the SMS by-response sub-rows under Reached.
function Row({ row, onOpen, indent = false }: { row: PerfRow; onOpen: () => void; indent?: boolean }) {
  const color = ROW_COLOR[row.key] ?? "#8b939c";
  return (
    <button
      type="button"
      onClick={onOpen}
      className={`w-full text-left rounded-md px-1.5 py-1 -mx-1.5 hover:bg-[var(--bg-hover)] transition-colors ${indent ? "pl-4" : ""}`}
    >
      <div className="flex items-center gap-2">
        <span className="h-1.5 w-1.5 rounded-full shrink-0" style={{ background: color }} />
        <span className="text-[11px] text-[var(--text-2)] flex items-center gap-1">
          {row.label}
          {row.isEstimated && (
            <span title="Best-effort estimate from call data, not a verified label." className="cursor-help text-[8.5px] uppercase tracking-wider text-[var(--text-3)] border border-[var(--border-2)] rounded px-1">est</span>
          )}
        </span>
        <span className="ml-auto text-[11px] font-medium font-mono text-[var(--text-1)]">{row.count.toLocaleString()}</span>
        <Pill pct={row.pct} color={color} />
        <DeltaChips a={row.deltaPpVsYesterday} b={row.deltaPpVsSevenDayAvg} fmt={ppText} />
      </div>
      <div className="mt-1"><Bar pct={row.pct} color={color} /></div>
    </button>
  );
}

function MetricCard({
  label,
  metric,
  isSms,
  inFlight,
  onOpenTotal,
  onOpenRow,
}: {
  label: string;
  metric: PerfMetric;
  isSms?: boolean;
  inFlight?: number;
  onOpenTotal: () => void;
  onOpenRow: (row: PerfRow, parentKey?: string) => void;
}) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 flex flex-col gap-3">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{label}</div>
      <button type="button" onClick={onOpenTotal} className="flex items-baseline gap-2 text-left group w-fit">
        <span className="text-3xl font-bold font-mono text-[var(--text-1)] group-hover:text-blue-400 transition-colors">
          {metric.total.toLocaleString()}
        </span>
        <DeltaChips a={metric.deltaPctVsYesterday} b={metric.deltaPctVsSevenDayAvg} fmt={pctText} />
      </button>
      {inFlight !== undefined && inFlight > 0 && (
        <div className="text-[10px] text-[var(--text-3)]">+{inFlight.toLocaleString()} in progress</div>
      )}
      <div className="flex flex-col gap-1.5">
        {metric.rows.map((row) => (
          <div key={row.key} className="flex flex-col gap-1.5">
            <Row row={row} onOpen={() => onOpenRow(row)} />
            {/* SMS "by response" sub-rows live under the Reached row. */}
            {isSms && row.subRows && row.subRows.length > 0 && (
              <div className="flex flex-col gap-1 border-l border-[var(--border)] ml-1.5">
                {row.subRows.map((sub) => (
                  <Row key={sub.key} row={sub} indent onOpen={() => onOpenRow(sub, row.key)} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// Map a clicked total/row to the semantic drawer filter (spec §6 — NOT the mockup's loose args).
function totalFilter(card: "callAttempts" | "reached" | "sms"): DrawerFilter {
  if (card === "reached") return { status: "all", outcome: "reached", smsOnly: false, title: "Reached contacts" };
  if (card === "sms") return { status: "all", outcome: "all", smsOnly: true, title: "SMS sent" };
  return { status: "all", outcome: "all", smsOnly: false, title: "All call records" };
}
function rowFilter(card: "callAttempts" | "reached" | "sms", rowKey: string, label: string): DrawerFilter {
  const outcome = rowKey as DrawerFilter["outcome"]; // row keys are AttemptTag | "reached"
  const smsOnly = card === "sms";
  const title = smsOnly ? `SMS — ${label.toLowerCase()}` : label;
  return { status: "all", outcome, smsOnly, title };
}

export default function TodayPerformanceCards({ data }: { data: TodaySnapshot | null }) {
  const [day, setDay] = useState<"today" | "yesterday">("today");
  const [filter, setFilter] = useState<DrawerFilter | null>(null);

  const perf: TodayPerfDay | null = data ? data[day] : null;
  const ops = data?.ops;

  // Close the drawer when switching the day (its records are day-scoped).
  const switchDay = (d: "today" | "yesterday") => { setDay(d); setFilter(null); };

  const openTotal = (card: "callAttempts" | "reached" | "sms") => setFilter(totalFilter(card));
  const openRow = (card: "callAttempts" | "reached" | "sms") => (row: PerfRow) => setFilter(rowFilter(card, row.key, row.label));

  const toggle = useMemo(
    () => (
      <div className="inline-flex items-center gap-0.5 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-0.5">
        {(["today", "yesterday"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => switchDay(d)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
              day === d ? "bg-[var(--bg-hover)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}
          >
            {d}
          </button>
        ))}
      </div>
    ),
    [day],
  );

  return (
    <section className="grid gap-3">
      {/* Control row: Today/Yesterday toggle + Active AI Agents chip */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        {toggle}
        {ops && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-[var(--text-3)] px-2 py-1 rounded-lg border border-[var(--border)]">
            <Radio size={12} className="text-[var(--text-2)]" />
            <span className="font-mono text-[var(--text-1)]">{ops.activeAgents}</span>/<span className="font-mono">{ops.totalAgents}</span> agents active
          </span>
        )}
      </div>

      {!perf ? (
        <p className="text-center text-xs text-[var(--text-3)] py-8">Loading today&apos;s performance…</p>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <MetricCard label="Call attempts" metric={perf.callAttempts} inFlight={perf.inFlight} onOpenTotal={() => openTotal("callAttempts")} onOpenRow={openRow("callAttempts")} />
            <MetricCard label="Reached" metric={perf.reached} onOpenTotal={() => openTotal("reached")} onOpenRow={openRow("reached")} />
            <MetricCard label="SMS sent" metric={perf.sms} isSms onOpenTotal={() => openTotal("sms")} onOpenRow={openRow("sms")} />
          </div>
          <TodayRecordsDrawer day={day} filter={filter} onClose={() => setFilter(null)} />
        </>
      )}
    </section>
  );
}
