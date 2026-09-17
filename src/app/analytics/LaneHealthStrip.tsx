"use client";

// Lane health strip (dashboard mockup, ported 2026-09-03). One card per brand × country that
// dialled: yesterday's connect rate with prod's verdict, today's figures so far. The verdict is
// judged on the LAST CLOSED DAY; today carries no verdict because a few hours of dialling is not a
// day (a Canadian zero at 08:45Z is the night). Worst lane first, so a dead trunk is the first
// thing on the page.
//
// 2026-09-17, ten brands: this used to be a wrapping wall of 3-line cards, and at 10 brands × 3
// markets it would be 30 of them. It is now the same sliding strip the Global charts use, with
// compact cards, a sort, and a "problems only" filter. Three things the redesign deliberately
// holds to:
//   · the repeated words ("connected", "dials", "today so far") were identical on every card and
//     carried no information per card — they moved to the section's own tooltip;
//   · every verdict renders in ONE fixed-width pill, because "too few to judge" was long enough to
//     overflow its own card while "ok" left a gap;
//   · a collapsing lane is loud ONCE (red border + red pill), not three times over. The card no
//     longer also fills red.
import { useMemo, useState } from "react";
import Hint from "@/components/Hint";
import StyledSelect from "@/components/StyledSelect";
import ChartStrip from "./ChartStrip";
import { brandGlyph, brandLabel } from "@/lib/campaignDisplay";
import { LANE_IS_PROBLEM, LANE_LABEL, LANE_RANK, LANE_SHORT, type LaneHealthRow, type LaneState } from "@/lib/laneHealth";

const fmt = (n: number) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso; };

// Quiet by default, coloured only where the operator must look. Transparent fills: the card's own
// border already carries the state, and a tinted pill on a tinted card was the "glaring" part.
const STATE_CLS: Record<LaneState, string> = {
  collapse: "text-red-400 border-red-500/40",
  idle: "text-[var(--text-3)] border-[var(--border-2)]",
  thin: "text-[var(--text-3)] border-[var(--border-2)]",
  ok: "text-emerald-400/90 border-emerald-500/25",
};

type SortKey = "worst" | "today" | "brand" | "market";
const SORTS = [
  { value: "worst", label: "Worst first" },
  { value: "today", label: "Most dials today" },
  { value: "brand", label: "Brand A-Z" },
  { value: "market", label: "Market" },
];

export default function LaneHealthStrip({ lanes }: { lanes: LaneHealthRow[] }) {
  const [sort, setSort] = useState<SortKey>("worst");
  const [problemsOnly, setProblemsOnly] = useState(false);

  const shown = useMemo(() => {
    const rows = problemsOnly ? lanes.filter((l) => LANE_IS_PROBLEM[l.state]) : [...lanes];
    const byBrand = (a: LaneHealthRow, b: LaneHealthRow) => brandLabel(a.brand).localeCompare(brandLabel(b.brand));
    switch (sort) {
      case "today": return rows.sort((a, b) => b.today.dials - a.today.dials || a.key.localeCompare(b.key));
      case "brand": return rows.sort((a, b) => byBrand(a, b) || a.country.localeCompare(b.country));
      case "market": return rows.sort((a, b) => a.country.localeCompare(b.country) || byBrand(a, b));
      // Worst first is prod's own ranking, and it is the default for a reason: a dead trunk has to
      // be the first card on the page.
      default: return rows.sort((a, b) => LANE_RANK[a.state] - LANE_RANK[b.state] || a.key.localeCompare(b.key));
    }
  }, [lanes, sort, problemsOnly]);

  if (lanes.length === 0) return null;
  const brands = new Set(lanes.map((l) => brandLabel(l.brand)));
  const judged = lanes[0].judgedOn;

  return (
    <div role="status" aria-label="Lane health" className="grid gap-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)]">
        <span className="font-semibold uppercase tracking-[0.07em]">Lanes</span>
        <Hint content={`One card per lane, a brand and market pair. Figures read connected of dials, then the connect rate, for ${shortDay(judged)} — the last closed day. "today" is dials so far, then connected. The verdict is prod's connect-collapse rule: at least 20 dials and under half connected is a collapse; under 20 dials it declines to judge. Today carries no verdict: a few hours of dialling is not a day.`}>
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--border-2)] text-[9px] cursor-help select-none">i</span>
        </Hint>

        <div className="ml-auto flex items-center gap-1.5">
          {/* Never hide a failure silently: when the filter is on, the page says what it is holding back. */}
          {problemsOnly && <span className="font-mono">{shown.length} of {lanes.length}</span>}
          <button
            type="button"
            onClick={() => setProblemsOnly((v) => !v)}
            aria-pressed={problemsOnly}
            title="Show only lanes that collapsed or did not dial"
            className={`px-2 py-1 rounded-md border text-[11px] transition-colors ${
              problemsOnly
                ? "border-red-500/40 text-red-400 bg-red-500/5"
                : "border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            Problems only
          </button>
          <div className="w-[164px]">
            <StyledSelect size="sm" prefix="Sort" value={sort} onChange={(v) => setSort(v as SortKey)} options={SORTS} />
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="text-[11px] text-[var(--text-3)] px-1 py-2">No lane collapsed or sat idle. Turn the filter off to see all {lanes.length}.</p>
      ) : (
        /* A fixed 204px, not a fraction of the rail: stretched cards left a band of dead space
           inside each one, because a lane's longest line is the figures and they are short. */
        <ChartStrip count={shown.length} noun="lanes" id="lane-strip" cardClass="[&>*]:w-[204px]">
          {shown.map((l) => {
            const y = l.yesterday;
            const figures = y.dials === 0 ? "no dials" : `${fmt(y.connected)}/${fmt(y.dials)} · ${((y.rate ?? 0) * 100).toFixed(1)}%`;
            return (
              <div
                key={l.key}
                data-lane={l.key}
                data-lane-state={l.state}
                className={`rounded-lg border px-2.5 py-2 bg-[var(--bg-card)] ${l.state === "collapse" ? "border-red-500/40" : "border-[var(--border)]"}`}
              >
                <div className="flex items-center gap-1.5 text-[12px] min-w-0">
                  {/* The glyph, not the name: at ten brands "Fortune Play" is wider than the figures
                      it sits above. Same two letters as the sidebar switcher. */}
                  {brands.size > 1 && (
                    <Hint content={brandLabel(l.brand)}>
                      <span className="shrink-0 font-mono text-[9.5px] leading-[14px] px-1 rounded border border-[var(--border-2)] text-[var(--text-3)] cursor-help">
                        {brandGlyph(brandLabel(l.brand))}
                      </span>
                    </Hint>
                  )}
                  <b className="text-[var(--text-1)] truncate">{l.country}</b>
                  <Hint content={LANE_LABEL[l.state]}>
                    <span className={`ml-auto shrink-0 w-[58px] text-center text-[10px] leading-[16px] rounded-full border cursor-help ${STATE_CLS[l.state]}`}>
                      {LANE_SHORT[l.state]}
                    </span>
                  </Hint>
                </div>
                <div className="font-mono text-[11px] text-[var(--text-2)] mt-1 truncate">{shortDay(judged)} {figures}</div>
                <div className="font-mono text-[11px] text-[var(--text-3)] truncate">
                  today {fmt(l.today.dials)}{l.today.dials > 0 ? ` · ${fmt(l.today.connected)}` : ""}
                </div>
              </div>
            );
          })}
        </ChartStrip>
      )}
    </div>
  );
}
