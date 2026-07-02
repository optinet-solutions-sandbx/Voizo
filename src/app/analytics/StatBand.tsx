"use client";

// Cost-Explorer-style KPI band: one horizontal strip of divider-separated stats
// (small muted label over a large numeral). Highest information-per-pixel element
// on the page — the console look's workhorse. Numbers count up via CountUp.

import CountUp from "@/components/CountUp";

export interface BandStat {
  label: string;
  /** number → CountUp numeral; string → rendered as-is (e.g. "3.5%"). */
  value: number | string;
  sub?: string;
}

export default function StatBand({ stats }: { stats: BandStat[] }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-1 py-2.5 flex flex-wrap items-stretch">
      {stats.map((s) => (
        <div key={s.label} className="px-4 border-l border-[var(--border)] first:border-l-0 min-w-[110px]">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)] whitespace-nowrap">{s.label}</div>
          <div className="text-xl font-bold font-mono text-[var(--text-1)] mt-0.5">
            {typeof s.value === "number" ? <CountUp value={s.value} /> : s.value}
          </div>
          {s.sub && <div className="text-[10px] text-[var(--text-3)] mt-0.5 whitespace-nowrap">{s.sub}</div>}
        </div>
      ))}
    </div>
  );
}
