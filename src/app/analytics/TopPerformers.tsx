"use client";

// Top Performers (Val's mockup, Slice E) — per-entity breakdown cards (Best Campaign / Voice Agent /
// Prompt). Each card = entity header (name + positive% + calls) + 3 stacked BreakdownColumns whose
// total + every row drill into an entity-scoped RangedRecordsDrawer (campaign id / base agent / sha).
// Replaces the static Best cards. Read-only; reuses the Slice-B drawer + Slice-A breakdown column.

import { useState, type ReactNode } from "react";
import { Trophy, Mic, FileText } from "lucide-react";
import type { PerfRow } from "@/lib/dashboardAnalytics";
import BreakdownColumn from "./BreakdownColumn";
import RangedRecordsDrawer, { type DrawerFilter, type DrawerScope, totalFilter, rowFilter } from "./RangedRecordsDrawer";
import type { Filters, BestPerformer } from "./GlobalPerformance";

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);
type Card = "callAttempts" | "reached" | "sms";

interface EntityCard {
  icon: ReactNode;
  label: string;
  accent: string;
  name: string;
  best: BestPerformer;
  scope: DrawerScope;
}

export default function TopPerformers({
  best,
  filters,
}: {
  best: { campaign: BestPerformer | null; agent: BestPerformer | null; prompt: BestPerformer | null };
  filters: Filters;
}) {
  const [drawer, setDrawer] = useState<{ scope: DrawerScope; filter: DrawerFilter } | null>(null);

  // A clicked total/row → the same semantic slice as the Global cards, scoped to the entity and with
  // an entity-prefixed title (e.g. "Best campaign · Reached"). rowFilter ignores the parent key.
  // Re-clicking the slice that's already open closes the drawer (toggle) — same scope + same
  // status/outcome/smsOnly (title is derived, so ignored).
  const openSlice = (scope: DrawerScope, entityLabel: string, card: Card, row?: PerfRow) => {
    const base = row ? rowFilter(card, row.key, row.label) : totalFilter(card);
    const next = { scope, filter: { ...base, title: `${entityLabel} · ${base.title}` } };
    setDrawer((prev) =>
      prev &&
      JSON.stringify(prev.scope) === JSON.stringify(next.scope) &&
      prev.filter.status === next.filter.status &&
      prev.filter.outcome === next.filter.outcome &&
      prev.filter.smsOnly === next.filter.smsOnly
        ? null
        : next,
    );
  };

  // Labels are already resolved by the caller (campaign/agent/prompt friendly text).
  const cards: EntityCard[] = [];
  if (best.campaign) {
    cards.push({ icon: <Trophy size={14} />, label: "Best campaign", accent: "text-[var(--text-1)]", name: best.campaign.label, best: best.campaign, scope: { campaignIds: [best.campaign.key] } });
  }
  if (best.agent) {
    cards.push({ icon: <Mic size={14} />, label: "Best voice agent", accent: "text-blue-400", name: best.agent.label, best: best.agent, scope: { baseAgent: best.agent.key } });
  }
  if (best.prompt) {
    cards.push({ icon: <FileText size={14} />, label: "Best prompt", accent: "text-amber-300", name: best.prompt.label, best: best.prompt, scope: { prompt: best.prompt.key } });
  }

  if (cards.length === 0) {
    return (
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 text-sm text-[var(--text-3)]">
        Not enough call volume to rank top performers yet.
      </div>
    );
  }

  return (
    <div className="grid gap-2">
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3.5 items-start">
        {cards.map((c) => (
          <div key={c.label} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">{c.label}</span>
              <span className="text-[var(--text-3)]">{c.icon}</span>
            </div>
            <div>
              <div className={`text-base font-semibold truncate ${c.accent}`} title={c.name}>{c.name}</div>
              <div className="text-[11px] text-[var(--text-3)] mt-0.5">
                <span className="text-[var(--text-2)] font-medium">{pct(c.best.positiveResponseRate)} positive response</span> · {c.best.calls.toLocaleString()} calls
              </div>
            </div>
            {c.best.perf ? (
              <div className="grid gap-3 mt-1">
                <BreakdownColumn metric={c.best.perf.callAttempts} label="Call attempts" collapsible onTotal={() => openSlice(c.scope, c.label, "callAttempts")} onRow={(r) => openSlice(c.scope, c.label, "callAttempts", r)} />
                <BreakdownColumn metric={c.best.perf.reached} label="Reached" collapsible onTotal={() => openSlice(c.scope, c.label, "reached")} onRow={(r) => openSlice(c.scope, c.label, "reached", r)} />
                <BreakdownColumn metric={c.best.perf.sms} label="SMS sent" collapsible onTotal={() => openSlice(c.scope, c.label, "sms")} onRow={(r) => openSlice(c.scope, c.label, "sms", r)} />
              </div>
            ) : (
              <div className="text-xs text-[var(--text-3)] mt-1">Breakdown unavailable for this window.</div>
            )}
          </div>
        ))}
      </div>
      <RangedRecordsDrawer filters={filters} filter={drawer?.filter ?? null} scope={drawer?.scope} onClose={() => setDrawer(null)} />
    </div>
  );
}
