"use client";

// Conversion Funnel (dashboard mockup, ported 2026-09-03): prod's pipeline fields drawn as one
// shape, attempts → connected → conversations established → SMS sent. Every bar is a share of
// attempts, from the SAME ranged perf block the section already computes (data.perf), so the
// numbers here equal the ones the cards used to print. Stage scopes: attempts and connected are
// the window's completed-call series; conversations and SMS come off the transcript-classified
// breakdown, which is why a % of the row above is printed only where the two rows share a scope.
import { Filter } from "lucide-react";
import type { TodayPerfDay } from "@/lib/dashboardAnalytics";
import WidgetCard from "./WidgetCard";
import { ROW_COLOR } from "./PerformanceCards";

const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (n: number, d: number) => (d > 0 ? `${((n / d) * 100).toFixed(1)}%` : "—");

export default function ConversionFunnel({ perf, connected, rangeDays }: { perf: TodayPerfDay | null; connected: number; rangeDays: number }) {
  const attempts = perf?.callAttempts.total ?? 0;
  const conversations = perf?.reached.total ?? 0;
  const sms = perf?.sms.total ?? 0;
  const rows = [
    { l: "Call attempts", v: attempts, color: ROW_COLOR.neutral, note: `measured — the ${rangeDays}-day series` },
    { l: "Connected", v: connected, color: ROW_COLOR.reached, note: attempts ? `${pct(connected, attempts)} of attempts` : "measured" },
    { l: "Conversations established", v: conversations, color: ROW_COLOR.positive, note: connected ? `${pct(conversations, connected)} of connected — a live two-way exchange` : "measured" },
    { l: "SMS sent", v: sms, color: ROW_COLOR.voicemail, note: conversations ? `${pct(sms, conversations)} of conversations` : "measured" },
  ];
  const w = (v: number) => (attempts && v ? Math.max((v / attempts) * 100, 0.6) : 0);
  return (
    <WidgetCard
      title="Conversion Funnel"
      icon={<Filter size={14} className="text-[var(--text-3)]" />}
      context="attempts → connected → conversations → texts, one shape, same window"
    >
      {!perf ? (
        <p className="text-xs text-[var(--text-3)] py-8 text-center">No completed calls in this window.</p>
      ) : (
        <div className="grid gap-2.5">
          {rows.map((r) => (
            <div key={r.l} className="grid grid-cols-[150px_1fr_64px] items-center gap-3 text-[12px]">
              <span className="text-[var(--text-2)]">{r.l}</span>
              <div className="h-[7px] rounded bg-[var(--bg-elevated)] overflow-hidden" title={`${r.l}: ${fmt(r.v)} · ${r.note}`}>
                <span className="block h-full rounded" style={{ width: `${w(r.v).toFixed(2)}%`, background: r.color }} />
              </div>
              <b className="font-mono text-[var(--text-1)] text-right tabular-nums">{fmt(r.v)}</b>
              <span className="col-span-3 -mt-1.5 text-[10.5px] text-[var(--text-4)]">{r.note}</span>
            </div>
          ))}
        </div>
      )}
    </WidgetCard>
  );
}
