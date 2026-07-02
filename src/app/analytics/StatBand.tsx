"use client";

// KPI strip (pattern brief / reference): equal-width cells on a 1px-gap grid where the gap
// IS the border, 27px tabular numerals (CountUp), 11px uppercase labels, --text-4 subs.
// Highest information-per-pixel element on the page. `accent` colors a value that carries
// meaning (e.g. Positive response in semantic green).

import CountUp from "@/components/CountUp";

export interface BandStat {
  label: string;
  /** number → CountUp numeral; string → rendered as-is (e.g. "3.5%"). */
  value: number | string;
  sub?: string;
  accent?: string; // value color override (semantic only — color is meaning)
}

export default function StatBand({ stats }: { stats: BandStat[] }) {
  return (
    <div
      className="grid gap-px bg-[var(--border)] border border-[var(--border)] rounded-[14px] overflow-hidden"
      style={{ gridTemplateColumns: `repeat(${stats.length}, minmax(0,1fr))` }}
    >
      {stats.map((s) => (
        <div key={s.label} className="bg-[#12141a] px-[18px] py-[15px] min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-3)] whitespace-nowrap truncate">{s.label}</div>
          <div
            className="text-[27px] leading-[1.1] font-semibold font-mono tracking-[-0.02em] mt-1.5"
            style={{ color: s.accent ?? "var(--text-1)" }}
          >
            {typeof s.value === "number" ? <CountUp value={s.value} /> : s.value}
          </div>
          <div className="text-[11px] text-[var(--text-4)] mt-0.5 h-[14px] whitespace-nowrap truncate">{s.sub ?? ""}</div>
        </div>
      ))}
    </div>
  );
}
