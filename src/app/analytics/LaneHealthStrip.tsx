"use client";

// Lane health strip (dashboard mockup, ported 2026-09-03). One card per brand × country that
// dialled: yesterday's connect rate with prod's verdict, today's figures so far. The verdict is
// judged on the LAST CLOSED DAY; today carries no verdict because a few hours of dialling is not a
// day (a Canadian zero at 08:45Z is the night). Worst lane first, so a dead trunk is the first
// thing on the page. Brand chip only when more than one brand is present: under one brand it is
// constant and says nothing.
import Hint from "@/components/Hint";
import { brandLabel } from "@/lib/campaignDisplay";
import { LANE_LABEL, type LaneHealthRow, type LaneState } from "@/lib/laneHealth";

const fmt = (n: number) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso); return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : iso; };

const STATE_CLS: Record<LaneState, string> = {
  collapse: "bg-red-500/10 text-red-400 border-red-500/30",
  idle: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
  thin: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]",
  ok: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
};

export default function LaneHealthStrip({ lanes }: { lanes: LaneHealthRow[] }) {
  if (lanes.length === 0) return null;
  const brands = new Set(lanes.map((l) => brandLabel(l.brand)));
  const judged = lanes[0].judgedOn;
  return (
    <div role="status" aria-label="Lane health" className="grid gap-2">
      <div className="flex items-center gap-1.5 text-[11px] text-[var(--text-3)]">
        <span className="font-semibold uppercase tracking-[0.07em]">Lanes</span>
        <span>{lanes.length} lane{lanes.length === 1 ? "" : "s"} · judged on {shortDay(judged)}, the last closed day · today shown as figures so far</span>
        <Hint content="One card per lane, a brand and market pair. The verdict is prod's connect-collapse rule on the last closed day: at least 20 dials and under half connected is a collapse; under 20 dials it declines to judge. Today carries no verdict: a few hours of dialling is not a day.">
          <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full border border-[var(--border-2)] text-[9px] cursor-help select-none">i</span>
        </Hint>
      </div>
      <div className="flex flex-wrap gap-2">
        {lanes.map((l) => {
          const y = l.yesterday;
          const figures = y.dials === 0 ? "no dials" : `${fmt(y.connected)} of ${fmt(y.dials)} connected · ${((y.rate ?? 0) * 100).toFixed(1)}%`;
          return (
            <div key={l.key} data-lane={l.key} data-lane-state={l.state}
              className={`flex-[1_1_210px] max-w-[330px] rounded-lg border px-3 py-2 ${l.state === "collapse" ? "border-red-500/40 bg-red-500/5" : "border-[var(--border)] bg-[var(--bg-card)]"}`}>
              <div className="flex items-center gap-2 text-[12.5px] min-w-0">
                {brands.size > 1 && <span className="shrink-0 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] text-[var(--text-3)]">{brandLabel(l.brand)}</span>}
                <b className="text-[var(--text-1)]">{l.country}</b>
                <span className={`ml-auto shrink-0 text-[11px] px-2 py-px rounded-full border ${STATE_CLS[l.state]}`}>{LANE_LABEL[l.state]}</span>
              </div>
              <div className="font-mono text-[11px] text-[var(--text-2)] mt-1">{shortDay(judged)}: {figures}</div>
              <div className="font-mono text-[11px] text-[var(--text-3)]">today so far: {fmt(l.today.dials)} dial{l.today.dials === 1 ? "" : "s"}{l.today.dials > 0 ? ` · ${fmt(l.today.connected)} connected` : ""}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
