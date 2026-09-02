// The Global Performance hero: one connect rate for the window, and whether it is gaining or
// losing against the equal-length window before it. Pure functions, no React, so the rules
// below are unit-tested rather than eyeballed.
//
// Connect rate here is prod's: connected / completed (terminal) calls, the same definition
// RateRow.connectRate uses everywhere else on the page. The mockup this was ported from used
// all attempts as the denominator; that would have disagreed with every other rate shown.

/** One day of the series: completed calls and how many of them connected. */
export interface DayCount {
  day: string; // YYYY-MM-DD (UTC)
  terminal: number;
  connected: number;
}

export interface WindowSummary {
  terminal: number;
  connected: number;
  /** connected / terminal as a percentage; null when nothing completed. NOT adjusted for
   *  outage days — this states what the window did, and must keep equalling the
   *  "N of M" printed beneath it. */
  rate: number | null;
  /** Days that completed calls and connected none. An outage, not trading. */
  deadDays: string[];
  /** Completed calls on those days — the only extra a like-for-like comparison needs. */
  deadTerminal: number;
}

export function summarizeWindow(days: DayCount[]): WindowSummary {
  let terminal = 0, connected = 0, deadTerminal = 0;
  const deadDays: string[] = [];
  for (const d of days) {
    terminal += d.terminal;
    connected += d.connected;
    if (d.terminal > 0 && d.connected === 0) {
      deadDays.push(d.day);
      deadTerminal += d.terminal;
    }
  }
  return { terminal, connected, rate: terminal ? (connected / terminal) * 100 : null, deadDays, deadTerminal };
}

export type Comparison =
  | { ok: false; why: string }
  | {
      ok: true;
      /** Percentage-point change, one decimal, after both sides drop their outage days. */
      pts: number;
      dropped: { day: string; side: "window" | "baseline" }[];
      droppedTerminal: number;
    };

/**
 * A day that completed calls and connected nothing is an outage, not trading, and BOTH sides
 * of the comparison drop those days before their rates are taken (mockup, 2026-08-28).
 *
 * Why symmetric exclusion and not a stricter refusal: the case that actually occurs is exactly
 * one dead day, and it can sit on either side. In the baseline it made the recovery from the
 * 08-08 trunk outage read as campaign improvement (a rise overstated roughly twelvefold, and
 * under one brand a printed rise across a real decline); in the current window it does the
 * reverse. Dropping the day moves only the denominator: it contributed no connects by
 * definition, so nothing is added back on either side.
 */
export function compareWindows(window: WindowSummary, baseline: WindowSummary | null): Comparison {
  if (!baseline || baseline.terminal === 0) {
    return { ok: false, why: "No completed calls in the prior window, so there is nothing to compare against." };
  }
  if (baseline.connected === 0) {
    return { ok: false, why: "Zero connects in the prior window. That is an outage, not a baseline." };
  }
  // live(baseline) cannot be 0 here: every dialling day dead means connected 0, refused above.
  const live = (w: WindowSummary) => w.terminal - w.deadTerminal;
  const rateNow = live(window) > 0 ? window.connected / live(window) : 0;
  const rateBase = baseline.connected / live(baseline);
  return {
    ok: true,
    pts: Number(((rateNow - rateBase) * 100).toFixed(1)),
    dropped: [
      ...window.deadDays.map((day) => ({ day, side: "window" as const })),
      ...baseline.deadDays.map((day) => ({ day, side: "baseline" as const })),
    ],
    droppedTerminal: window.deadTerminal + baseline.deadTerminal,
  };
}

/** Three states, not two: a delta that rounds to nothing is reported as no change. The old
 *  two-way test sent every non-negative value down the "up" arm and printed a rise for 0.0. */
export function deltaLabel(pts: number): { dir: "up" | "down" | "flat"; text: string } {
  const r = Number(pts.toFixed(1));
  if (r > 0) return { dir: "up", text: `▲ ${r.toFixed(1)} pts` };
  if (r < 0) return { dir: "down", text: `▼ ${Math.abs(r).toFixed(1)} pts` };
  return { dir: "flat", text: "▪ No change" };
}

/** The per-campaign-per-day rows `dashboard_call_rollup` returns, reduced to the per-day series
 *  the hero compares against. `keep` applies the SAME campaign-level exclusions the main window
 *  applied (ghost, test, campaign picker, country, prompt), so both sides describe one scope.
 *  Rows for a campaign that fails `keep` are dropped whole; days are zero-filled by the caller. */
export function baselineSeries(
  rows: { campaign_id: string; day_utc: string; terminal: number; connected: number }[],
  keep: (campaignId: string) => boolean,
): DayCount[] {
  const byDay = new Map<string, DayCount>();
  for (const r of rows) {
    if (!keep(r.campaign_id)) continue;
    const d = byDay.get(r.day_utc) ?? { day: r.day_utc, terminal: 0, connected: 0 };
    d.terminal += r.terminal;
    d.connected += r.connected;
    byDay.set(r.day_utc, d);
  }
  return [...byDay.values()].sort((a, b) => a.day.localeCompare(b.day));
}

/** Bars the hero can actually draw. Two facts about the raw series make this necessary:
 *  the lifetime window zero-fills from 1970 (20,699 points measured 2026-09-02), and even a
 *  90-day window is 91 bars, which overflowed the card by 358px. So: drop the idle days before
 *  the first completed call, and once more than `maxBars` days remain, bucket them into weeks
 *  (7 days each, labelled by the bucket's first day; the last bucket may be short). A bucket's
 *  rate is its connects over its completed calls, not an average of daily rates. */
export function barSeries(days: DayCount[], maxBars = 31): { label: string; terminal: number; connected: number; days: number }[] {
  const firstLive = days.findIndex((d) => d.terminal > 0);
  const live = firstLive < 0 ? [] : days.slice(firstLive);
  if (live.length <= maxBars) return live.map((d) => ({ label: d.day, terminal: d.terminal, connected: d.connected, days: 1 }));
  const out: { label: string; terminal: number; connected: number; days: number }[] = [];
  for (let i = 0; i < live.length; i += 7) {
    const chunk = live.slice(i, i + 7);
    out.push({
      label: chunk[0].day,
      terminal: chunk.reduce((s, d) => s + d.terminal, 0),
      connected: chunk.reduce((s, d) => s + d.connected, 0),
      days: chunk.length,
    });
  }
  return out;
}
