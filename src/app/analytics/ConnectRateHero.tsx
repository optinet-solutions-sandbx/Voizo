"use client";

// Global Performance's hero (ported from the dashboard mockup, Jasiel 2026-09-02): ONE connect
// rate for the window and whether it is gaining or losing against the equal-length window
// before it. This replaced the three PerformanceCards that sat here: their Call attempts /
// Reached / SMS numbers duplicate Campaign Performance's own summary below, and Global's job
// is the one question those cards never answered.
//
// The rate is prod's connect rate (connected / completed calls), so it equals the KPI the
// route computes for the same window. The comparison drops outage days on BOTH sides first;
// the rate itself is never adjusted. All of that logic lives in lib/connectRateHero.ts and is
// unit-tested; this file only draws it.

import Hint from "@/components/Hint";
import type { TrendPoint } from "@/lib/dashboardAnalytics";
import {
  summarizeWindow, compareWindows, deltaLabel, barSeries, type DayCount,
} from "@/lib/connectRateHero";
import { ROW_COLOR, EstBadge } from "./PerformanceCards";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDate = (iso: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso;
};
const fmt = (n: number) => n.toLocaleString("en-US");

function Info({ text }: { text: string }) {
  return (
    <Hint content={<span className="block max-w-[320px] text-[11px] leading-relaxed">{text}</span>}>
      <span
        tabIndex={0}
        role="note"
        aria-label={text}
        className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--border-2)] text-[9px] text-[var(--text-3)] cursor-help select-none align-middle"
      >
        i
      </span>
    </Hint>
  );
}

export default function ConnectRateHero({
  trend,
  baseline,
  rangeDays,
  todayIso,
  estimated,
  noBaselineWhy,
}: {
  trend: TrendPoint[];
  baseline: DayCount[] | null;
  rangeDays: number;
  /** Today's UTC date: the bar for it is drawn faded, it is still running. */
  todayIso: string;
  /** Long windows include connects not yet evaluated for voicemail (forward-only detection). */
  estimated: boolean;
  /** Why there is no baseline when the API sent none ON PURPOSE (all time, a number search).
   *  Without it a null baseline reads as "no completed calls in the prior window", which is
   *  a different claim and a wrong one. */
  noBaselineWhy?: string;
}) {
  const days: DayCount[] = trend.map((p) => ({ day: p.day, terminal: p.terminal, connected: p.connected }));
  const A = summarizeWindow(days);
  const B = baseline ? summarizeWindow(baseline) : null;
  const g = !B && noBaselineWhy ? { ok: false as const, why: noBaselineWhy } : compareWindows(A, B);
  const notConnected = A.terminal - A.connected;
  const pc = A.rate ?? 0;
  // One bar per day up to a month; weekly buckets past that; the 1970 zero-fill trimmed.
  const bars = barSeries(days);
  const weekly = bars.some((b) => b.days > 1);
  const peak = Math.max(1, ...bars.map((b) => (b.terminal ? (b.connected / b.terminal) * 100 : 0)));
  // the window as drawn: the first day with a completed call (lifetime zero-fills from 1970)
  const first = bars[0]?.label, last = days[days.length - 1]?.day;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] px-5 py-4">
      {estimated && (
        <p className="text-[11px] text-[var(--text-3)] flex items-center gap-1.5 mb-3">
          <EstBadge tone="warn" content="Estimated: long windows include connects not yet evaluated for voicemail (forward-only from ~19 Jun), which count as reached." />
          Reached-based splits are best-effort over this window. Voicemail detection is forward-only from ~19 Jun.
        </p>
      )}

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h3 className="text-[13px] font-semibold text-[var(--text-1)] flex items-center gap-1.5">
          Connect rate
          <Info text="Connected calls as a share of completed calls. Connected means the carrier put the call through and there was talk time, which includes answering machines. The same definition every other connect rate on this page uses." />
        </h3>
        {first && last && (
          <span className="text-[11px] font-mono text-[var(--text-3)]">
            {shortDate(first)} → {shortDate(last)} · {rangeDays}-day series
          </span>
        )}
      </div>

      <div className="flex items-end gap-6 flex-wrap mt-2.5 mb-1">
        <div>
          <div className="font-mono text-[38px] font-medium leading-none tracking-[-0.03em] text-[var(--text-1)]">
            {A.rate == null ? "—" : `${A.rate.toFixed(1)}%`}
          </div>
          <div className="text-[11px] text-[var(--text-3)] mt-1.5">
            {fmt(A.connected)} of {fmt(A.terminal)} completed calls
          </div>
          {/* The rate above INCLUDES outage days: it reports what the window did. Say so where
              the number is read, not on a range bar somewhere else. */}
          {A.deadDays.length > 0 && (
            <div className="text-[11px] text-amber-400/90 mt-1 flex items-center gap-1">
              ⚠ includes {A.deadDays.length} outage day{A.deadDays.length === 1 ? "" : "s"}: {A.deadDays.map(shortDate).join(", ")},{" "}
              {fmt(A.deadTerminal)} completed calls, zero connects
              <Info text="Those calls are inside the figure above, because it reports what the window actually did. The comparison beside it drops them, where mixing them in would turn an outage into a trend." />
            </div>
          )}
        </div>

        <div className="flex flex-col gap-0.5 pb-0.5 min-w-[200px]">
          {g.ok ? (
            (() => {
              const d = deltaLabel(g.pts);
              const cls = d.dir === "up" ? "text-[#3ec08a] font-mono" : d.dir === "down" ? "text-[#e46664] font-mono" : "text-[var(--text-2)]";
              const dropped = g.dropped;
              const byBase = dropped.filter((x) => x.side === "baseline").map((x) => shortDate(x.day));
              const byWin = dropped.filter((x) => x.side === "window").map((x) => shortDate(x.day));
              return (
                <>
                  <span className={`text-[13px] ${cls}`}>{d.text}</span>
                  <span className="text-[11px] text-[var(--text-3)] flex items-center gap-1 flex-wrap">
                    {/* The baseline's SIZE, always: at 90d the previous window is the pilot
                        (1,140 completed calls against 76,541, measured 2026-09-02). The delta is
                        arithmetically honest; the reader still needs to see what it stands on. */}
                    vs the previous {rangeDays} days ({fmt(B!.connected)} of {fmt(B!.terminal)} completed)
                    {dropped.length > 0 && (
                      <>
                        {" · "}{dropped.length} outage day{dropped.length === 1 ? "" : "s"} excluded
                        <Info text={
                          `A day that completed calls and connected nothing is an outage, not trading. Both sides of this comparison drop those days before their rates are taken, so the two figures describe the same kind of day. ` +
                          `Dropped: ${[byWin.length ? `${byWin.join(", ")} from this window` : "", byBase.length ? `${byBase.join(", ")} from the baseline` : ""].filter(Boolean).join("; ")}. ` +
                          `Only the denominator moves; such a day contributes no connects by definition. The rate on the left is NOT adjusted.`
                        } />
                      </>
                    )}
                  </span>
                </>
              );
            })()
          ) : (
            <span className="text-[11px] text-[var(--text-3)] leading-relaxed max-w-[330px]">▪ No comparable baseline. {g.why}</span>
          )}
        </div>

        {/* One bar per day (or per week past a month), height = that period's connect rate
            against the window's best. A dead period is hatched, one with no calls is a flat
            stub, the period holding today is faded. Labels only when they fit: every bar for
            two weeks or less, every 7th day up to a month, the week's first day when weekly. */}
        <div className="flex items-end gap-[3px] h-[52px] flex-1 min-w-[230px] overflow-hidden" aria-label={weekly ? "Connect rate by week" : "Connect rate by day"}>
          {bars.map((b, i) => {
            const rate = b.terminal ? (b.connected / b.terminal) * 100 : null;
            const dead = b.terminal > 0 && b.connected === 0;
            const idle = b.terminal === 0;
            const h = rate && !dead ? (rate / peak) * 100 : 0;
            const when = weekly ? `week of ${shortDate(b.label)}` : shortDate(b.label);
            const title = idle
              ? `${when}: no completed calls`
              : dead
                ? `${when}: ${fmt(b.terminal)} completed, ZERO connected`
                : `${when}: ${fmt(b.connected)} of ${fmt(b.terminal)} connected (${rate!.toFixed(1)}%)`;
            const holdsToday = weekly ? i === bars.length - 1 && b.label <= todayIso : b.label === todayIso;
            const showLabel = bars.length <= 15 || weekly || i % 7 === 0;
            return (
              <span key={b.label} className="flex-1 flex flex-col justify-end items-center gap-1 h-full min-w-0" title={title + (holdsToday ? " (includes today, still running)" : "")}>
                <span
                  className={`w-full rounded-t-[2px] ${holdsToday ? "opacity-45" : ""}`}
                  style={
                    idle
                      ? { height: 2, background: "var(--bg-hover)" }
                      : dead
                        ? { height: "100%", background: `repeating-linear-gradient(45deg, ${ROW_COLOR.unreachable} 0 2px, transparent 2px 4px)`, opacity: 0.7 }
                        : { height: `${h.toFixed(1)}%`, minHeight: 1, background: ROW_COLOR.reached }
                  }
                />
                <span className="font-mono text-[10px] text-[var(--text-3)] whitespace-nowrap h-[13px]">
                  {showLabel ? (weekly ? shortDate(b.label) : b.label.slice(8)) : ""}
                </span>
              </span>
            );
          })}
        </div>
      </div>

      {/* The split: what happened to every completed call in the window. */}
      <div className="flex h-1.5 rounded-[3px] overflow-hidden mt-3.5 mb-2">
        <span style={{ flex: A.connected || 0, background: ROW_COLOR.reached }} />
        <span style={{ flex: notConnected || 0, background: ROW_COLOR.unreachable }} />
      </div>
      <div className="grid gap-1 text-[12px]">
        <div className="flex items-center gap-2">
          <span className="w-[3px] h-3.5 rounded-sm" style={{ background: ROW_COLOR.reached }} />
          <span className="text-[var(--text-2)] flex items-center gap-1">
            <span className="font-mono text-[var(--text-1)]">{pc.toFixed(1)}%</span> connected
            <Info text="The carrier put us through and there was talk time. Includes answering machines, so this is not the same as reaching a person." />
          </span>
          <span className="ml-auto font-mono text-[var(--text-1)]">{fmt(A.connected)}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-[3px] h-3.5 rounded-sm" style={{ background: ROW_COLOR.unreachable }} />
          <span className="text-[var(--text-2)] flex items-center gap-1">
            <span className="font-mono text-[var(--text-1)]">{(100 - pc).toFixed(1)}%</span> not connected
            <Info text="The carrier never put us through: no talk time at all. Carrier refusals live here." />
          </span>
          <span className="ml-auto font-mono text-[var(--text-1)]">{fmt(notConnected)}</span>
        </div>
      </div>
    </div>
  );
}
