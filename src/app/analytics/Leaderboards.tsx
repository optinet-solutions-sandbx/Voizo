"use client";

// Leaderboards (pattern brief §6): ONE module replaces the four that told the same story
// (Top Performers cards + Voice Agent Performance + Prompt Performance + Top Campaigns).
// A dimension switch (Campaigns / Voice agents / Prompts), a best-in-view highlight card,
// and one ranked table. Every row drills into the entity-scoped records drawer (the same
// scope mechanics the old Top Performers cards used). Rows with < MIN_RANK calls rank
// after qualified ones (thin samples can't top the board).

import { useCallback, useState, type ReactNode } from "react";
import { Trophy, Megaphone, Mic, FileText } from "lucide-react";
import { formatCampaign } from "@/lib/campaignDisplay";
import { useBaseAgentNames } from "./useBaseAgentNames";
import RangedRecordsDrawer, { type DrawerFilter, type DrawerScope, totalFilter } from "./RangedRecordsDrawer";
import { useDrawerClaim } from "./drawerExclusivity";
import type { Filters, BestPerformer } from "./GlobalPerformance";

// Row shapes for the three dimensions (moved from RankedTables, 2026-07-02).
export interface AgentRow {
  baseAssistantId: string;
  calls: number;
  connectRate: number | null;
  successRate: number | null;
  reach: number;
  smsSent: number;
  positiveResponseRate: number | null;
  campaignCount: number;
}
export interface CampaignLbRow {
  id: string;
  name: string;
  country: string;
  status: string; // raw campaigns_v2.status
  baseAssistantId: string | null;
  calls: number;
  connectRate: number | null;
  successRate: number | null;
  reach: number;
  smsSent: number;
  positiveResponseRate: number | null;
}
export interface PromptRow {
  sha: string;
  label: string;
  baseAssistantId: string | null;
  campaignId: string | null;
  calls: number;
  connectRate: number | null;
  successRate: number | null;
  reach: number;
  smsSent: number;
  positiveResponseRate: number | null;
  campaignCount: number;
}

type Dimension = "campaigns" | "agents" | "prompts";
const DIMS: { key: Dimension; label: string; tag: string; icon: ReactNode }[] = [
  { key: "campaigns", label: "Campaigns", tag: "Best campaign", icon: <Megaphone size={15} /> },
  { key: "agents", label: "Voice agents", tag: "Best voice agent", icon: <Mic size={15} /> },
  { key: "prompts", label: "Prompts", tag: "Best prompt", icon: <FileText size={15} /> },
];

const MIN_RANK = 10; // calls needed to compete for rank (thin samples sort after)
const TOP_N = 8;
const pct = (n: number | null | undefined) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

// Top-3 medal tints (qualified rows only); everything else neutral.
const RANK_CLS = [
  "bg-amber-400/20 text-amber-300 border-amber-400/40",
  "bg-slate-300/20 text-slate-200 border-slate-300/40",
  "bg-orange-500/20 text-orange-300 border-orange-500/40",
];

interface BoardRow {
  key: string;
  name: string;
  sub: string;
  calls: number;
  connectRate: number | null;
  reach: number;
  smsSent: number;
  positiveResponseRate: number | null;
  scope: DrawerScope;
}

const GRID = "grid grid-cols-[40px_minmax(0,1fr)_66px_78px_66px_66px_78px] gap-2 items-center";

export default function Leaderboards({
  campaigns,
  agents,
  prompts,
  best,
  filters,
}: {
  campaigns: CampaignLbRow[];
  agents: AgentRow[];
  prompts: PromptRow[];
  best: { campaign: BestPerformer | null; agent: BestPerformer | null; prompt: BestPerformer | null };
  filters: Filters;
}) {
  const [dim, setDim] = useState<Dimension>("campaigns");
  const [drawer, setDrawer] = useState<{ scope: DrawerScope; filter: DrawerFilter } | null>(null);
  const closeSelf = useCallback(() => setDrawer(null), []);
  useDrawerClaim("leaderboards", drawer !== null, closeSelf);
  const baseAgentName = useBaseAgentNames();

  const rows: BoardRow[] =
    dim === "campaigns"
      ? campaigns.map((c) => ({
          key: c.id,
          name: formatCampaign(c.name).display,
          sub: `${c.country !== "UNKNOWN" ? `${c.country} · ` : ""}${baseAgentName(c.baseAssistantId) ?? "—"}`,
          calls: c.calls,
          connectRate: c.connectRate,
          reach: c.reach,
          smsSent: c.smsSent,
          positiveResponseRate: c.positiveResponseRate,
          scope: { campaignIds: [c.id] },
        }))
      : dim === "agents"
        ? agents.map((a) => ({
            key: a.baseAssistantId,
            name: baseAgentName(a.baseAssistantId) ?? a.baseAssistantId.slice(0, 8),
            sub: `${a.campaignCount} campaign${a.campaignCount === 1 ? "" : "s"}`,
            calls: a.calls,
            connectRate: a.connectRate,
            reach: a.reach,
            smsSent: a.smsSent,
            positiveResponseRate: a.positiveResponseRate,
            scope: { baseAgent: a.baseAssistantId },
          }))
        : prompts.map((p) => ({
            key: p.sha,
            name: p.label,
            sub: `${p.campaignCount} campaign${p.campaignCount === 1 ? "" : "s"} · sha ${p.sha.slice(0, 6)}`,
            calls: p.calls,
            connectRate: p.connectRate,
            reach: p.reach,
            smsSent: p.smsSent,
            positiveResponseRate: p.positiveResponseRate,
            scope: { prompt: p.sha },
          }));

  const byPositive = (a: BoardRow, b: BoardRow) => (b.positiveResponseRate ?? -1) - (a.positiveResponseRate ?? -1);
  const qualified = rows.filter((r) => r.calls >= MIN_RANK).sort(byPositive);
  const thin = rows.filter((r) => r.calls < MIN_RANK).sort(byPositive);
  const ranked = [...qualified, ...thin];
  const top = ranked.slice(0, TOP_N);

  const dimMeta = DIMS.find((d) => d.key === dim)!;
  const bestFor = dim === "campaigns" ? best.campaign : dim === "agents" ? best.agent : best.prompt;

  // Row click → entity-scoped records drawer; re-clicking the open entity closes (toggle).
  const openRow = (r: BoardRow) => {
    const base = totalFilter("callAttempts");
    const next = { scope: r.scope, filter: { ...base, title: `${r.name} · ${base.title}` } };
    setDrawer((prev) => (prev && JSON.stringify(prev.scope) === JSON.stringify(next.scope) ? null : next));
  };

  return (
    <div className="grid gap-3.5">
      {/* External module header (icon + title + context + dimension switch). */}
      <div className="flex items-center gap-2.5 flex-wrap">
        <Trophy size={17} className="text-[var(--text-3)]" />
        <h3 className="text-[15px] font-semibold">Leaderboards</h3>
        <span className="text-[13px] text-[var(--text-3)]">best performers in this window · every row drills into records</span>
        <span className="flex-1" />
        <div className="inline-flex p-[3px] gap-0.5 rounded-[10px] bg-[var(--bg-elevated)] border border-[var(--border)]">
          {DIMS.map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => setDim(d.key)}
              className={`px-3 py-1.5 rounded-[7px] text-[12.5px] font-semibold transition ${
                dim === d.key ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
              }`}
            >
              {d.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex gap-4 items-stretch flex-wrap">
        {/* Best-in-view highlight. */}
        <div className="w-[296px] flex-none bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] overflow-hidden">
          <div className="h-[3px]" style={{ background: "linear-gradient(90deg,#e0b23c,#c98a4a)" }} />
          <div className="p-5">
            <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-[#e0b23c]">
              {dimMeta.icon}
              {dimMeta.tag}
            </div>
            {bestFor ? (
              <>
                <div className="text-[17px] font-semibold text-[var(--text-1)] mt-3.5 mb-1 leading-snug line-clamp-2" title={bestFor.label}>
                  {bestFor.label}
                </div>
                <div className="text-[12.5px] text-[var(--text-3)]">{bestFor.calls.toLocaleString()} calls in this window</div>
                <div className="h-px bg-[var(--border)] my-4" />
                <div className="flex items-baseline gap-2">
                  <span className="text-[30px] leading-none font-semibold font-mono tracking-[-0.02em] text-[#3ec08a]">
                    {pct(bestFor.positiveResponseRate)}
                  </span>
                  <span className="text-xs text-[var(--text-3)]">positive response</span>
                </div>
              </>
            ) : (
              <p className="text-xs text-[var(--text-3)] mt-4">Not enough call volume to rank yet.</p>
            )}
          </div>
        </div>

        {/* Ranked table. */}
        <div className="flex-1 min-w-[420px] bg-[var(--bg-card)] border border-[var(--border)] rounded-[14px] overflow-hidden">
          <div className={`${GRID} px-4 py-3 border-b border-[var(--border)] text-[10.5px] font-semibold uppercase tracking-[0.07em] text-[var(--text-4)]`}>
            <div>#</div>
            <div>Name</div>
            <div className="text-right">Calls</div>
            <div className="text-right">Connect</div>
            <div className="text-right">Reached</div>
            <div className="text-right">SMS</div>
            <div className="text-right">Positive</div>
          </div>
          {top.length === 0 ? (
            <p className="px-4 py-8 text-center text-xs text-[var(--text-3)]">No activity in this window.</p>
          ) : (
            top.map((r, i) => {
              const medal = i < 3 && r.calls >= MIN_RANK;
              return (
                <button
                  key={r.key}
                  type="button"
                  onClick={() => openRow(r)}
                  className={`w-full ${GRID} px-4 py-3 border-b border-[var(--border)] last:border-b-0 text-left hover:bg-[var(--bg-hover)] transition-colors ${
                    r.calls < MIN_RANK ? "opacity-60" : ""
                  }`}
                >
                  <div>
                    <span
                      className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold font-mono border shrink-0 ${
                        medal ? RANK_CLS[i] : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
                      }`}
                    >
                      {i + 1}
                    </span>
                  </div>
                  <div className="min-w-0">
                    <div className="text-[13.5px] font-medium text-[var(--text-1)] truncate">{r.name}</div>
                    <div className="text-[11.5px] text-[var(--text-4)] truncate">{r.sub}</div>
                  </div>
                  <div className="text-right font-mono text-[13px] text-[var(--text-2)]">{r.calls.toLocaleString()}</div>
                  <div className="text-right font-mono text-[13px] text-[#3ec08a]">{pct(r.connectRate)}</div>
                  <div className="text-right font-mono text-[13px] text-[var(--text-2)]">{r.reach.toLocaleString()}</div>
                  <div className="text-right font-mono text-[13px] text-[var(--text-2)]">{r.smsSent.toLocaleString()}</div>
                  <div className="text-right font-mono text-[13px] font-semibold text-[var(--text-1)]">{pct(r.positiveResponseRate)}</div>
                </button>
              );
            })
          )}
          {ranked.length > top.length && (
            <div className="px-4 py-2 text-[11px] text-[var(--text-4)] border-t border-[var(--border)]">
              Top {top.length} of {ranked.length} by positive response · under-{MIN_RANK}-call rows rank last · full list in
              Campaign Performance below.
            </div>
          )}
        </div>
      </div>

      <RangedRecordsDrawer filters={filters} filter={drawer?.filter ?? null} scope={drawer?.scope} onClose={closeSelf} />
    </div>
  );
}
