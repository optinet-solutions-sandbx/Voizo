"use client";

// Slice 4b — ranked Agent table (by BASE agent) + Top-Campaigns leaderboard, both driven
// by the global filters. Gold/silver/bronze medals for the top-3 QUALIFIED rows (>= MIN_RANK
// calls); thin-volume rows rank below, muted + no medal (same Goodhart guard as the Best cards).
// Prompt Performance table is deferred (no prompt names in our data — see note in the dashboard).

import { useState } from "react";
import { Mic, Trophy, FileText } from "lucide-react";
import { useBaseAgentNames } from "./useBaseAgentNames";
import { formatCampaign, promptAgentLabel } from "@/lib/campaignDisplay";
import PromptModal from "./PromptModal";
import CampaignDetailsModal from "./CampaignDetailsModal";
import Pagination from "@/components/Pagination";

const MIN_RANK = 10; // calls required to qualify for a medal / top ranking
const PROMPT_PAGE_SIZE = 8; // Prompt Performance rows per page
const AGENT_PAGE_SIZE = 6; // Voice Agent Performance rows per page (rarely paginates — few base agents)
const LEADERBOARD_PAGE_SIZE = 6; // Top Performing Campaigns cards per page

export interface AgentRow {
  baseAssistantId: string;
  calls: number;
  connectRate: number | null;
  successRate: number | null;
  campaignCount: number;
}
export interface CampaignLbRow {
  id: string;
  name: string;
  country: string;
  status: string; // raw campaigns_v2.status (running/paused/completed/inactive) — for the details modal pill
  baseAssistantId: string | null;
  calls: number;
  connectRate: number | null;
  successRate: number | null;
}
export interface PromptRow {
  sha: string;
  label: string;
  baseAssistantId: string | null;
  campaignId: string | null; // representative campaign for opening the full prompt
  calls: number;
  connectRate: number | null;
  successRate: number | null;
  campaignCount: number;
}

export type SortKey = "calls" | "connect" | "success" | "newest";
const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

function sortVal(r: { calls: number; connectRate: number | null; successRate: number | null }, key: SortKey): number {
  if (key === "calls") return r.calls;
  if (key === "connect") return r.connectRate ?? -1;
  return r.successRate ?? -1;
}
/** Qualified rows (>= MIN_RANK calls) sorted by the metric, then thin rows after. */
function rankOrder<T extends { calls: number; connectRate: number | null; successRate: number | null }>(
  rows: T[],
  key: SortKey,
): { qualified: T[]; thin: T[] } {
  const byMetric = (a: T, b: T) => sortVal(b, key) - sortVal(a, key);
  return {
    qualified: rows.filter((r) => r.calls >= MIN_RANK).sort(byMetric),
    thin: rows.filter((r) => r.calls < MIN_RANK).sort(byMetric),
  };
}

const RANK_CLS = [
  "bg-amber-400/20 text-amber-300 border-amber-400/40",
  "bg-slate-300/20 text-slate-200 border-slate-300/40",
  "bg-orange-500/20 text-orange-300 border-orange-500/40",
];
function RankBadge({ rank, medal }: { rank: number; medal: boolean }) {
  const cls = medal && rank <= 3 ? RANK_CLS[rank - 1] : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]";
  return (
    <span className={`inline-flex items-center justify-center w-6 h-6 rounded-full text-[11px] font-bold border shrink-0 ${cls}`}>
      {rank}
    </span>
  );
}

export function SortControl({
  sort,
  setSort,
  keys = ["calls", "connect", "success"],
}: {
  sort: SortKey;
  setSort: (s: SortKey) => void;
  keys?: SortKey[];
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Sort</span>
      <div className="inline-flex rounded-lg border border-[var(--border)] overflow-hidden">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setSort(k)}
            className={`px-2.5 py-1 text-xs font-medium capitalize transition ${
              sort === k ? "bg-blue-600 text-white" : "text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {k}
          </button>
        ))}
      </div>
    </div>
  );
}

function AgentTable({ agents }: { agents: AgentRow[] }) {
  const [sort, setSort] = useState<SortKey>("success");
  const [page, setPage] = useState(1);
  const baseAgentName = useBaseAgentNames();
  const { qualified, thin } = rankOrder(agents, sort);
  const ordered = [...qualified, ...thin];
  const totalPages = Math.max(1, Math.ceil(ordered.length / AGENT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = ordered.slice((safePage - 1) * AGENT_PAGE_SIZE, safePage * AGENT_PAGE_SIZE);

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Mic size={15} className="text-[var(--text-3)]" />
          <h3 className="text-[15px] font-semibold">Voice Agent Performance</h3>
        </div>
        <SortControl sort={sort} setSort={(s) => { setSort(s); setPage(1); }} />
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-4 text-center">No agent data in this window.</p>
      ) : (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-3 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] mb-1">
            <span className="w-6" />
            <span className="flex-1">Agent</span>
            <span className="w-16 text-right">Calls</span>
            <span className="w-16 text-right">Connect</span>
            <span className="w-16 text-right">Success</span>
          </div>
          {pageRows.map((a, i) => {
            const isThin = a.calls < MIN_RANK;
            const rank = (safePage - 1) * AGENT_PAGE_SIZE + i + 1;
            return (
              <div key={a.baseAssistantId} className={`flex items-center gap-3 py-1.5 ${isThin ? "opacity-50" : ""}`}>
                <RankBadge rank={rank} medal={!isThin} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-1)] truncate">
                    {baseAgentName(a.baseAssistantId) ?? "Unknown agent"}
                  </div>
                  <div className="text-[10px] text-[var(--text-3)]">{a.campaignCount} campaign{a.campaignCount === 1 ? "" : "s"}</div>
                </div>
                <div className="font-mono text-xs text-[var(--text-2)] w-16 text-right">{a.calls.toLocaleString()}</div>
                <div className="font-mono text-xs text-emerald-400 w-16 text-right">{pct(a.connectRate)}</div>
                <div className="font-mono text-xs text-amber-400 w-16 text-right">{pct(a.successRate)}</div>
              </div>
            );
          })}
        </div>
      )}
      {ordered.length > AGENT_PAGE_SIZE && (
        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          totalItems={ordered.length}
          pageSize={AGENT_PAGE_SIZE}
          onPageChange={setPage}
          noun="agents"
        />
      )}
    </section>
  );
}

function Leaderboard({
  campaigns,
  rangeDays,
  onFocusCampaign,
}: {
  campaigns: CampaignLbRow[];
  rangeDays: number;
  onFocusCampaign: (id: string) => void;
}) {
  const [sort, setSort] = useState<SortKey>("success");
  const [page, setPage] = useState(1);
  const [detailFor, setDetailFor] = useState<CampaignLbRow | null>(null);
  const baseAgentName = useBaseAgentNames();
  const { qualified, thin } = rankOrder(campaigns, sort);
  const ordered = [...qualified, ...thin];
  const totalPages = Math.max(1, Math.ceil(ordered.length / LEADERBOARD_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = ordered.slice((safePage - 1) * LEADERBOARD_PAGE_SIZE, safePage * LEADERBOARD_PAGE_SIZE);

  return (
    <section className="grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Trophy size={15} className="text-[var(--text-3)]" />
          <h3 className="text-[15px] font-semibold">Top Performing Campaigns</h3>
        </div>
        <SortControl sort={sort} setSort={(s) => { setSort(s); setPage(1); }} />
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-4 text-center">No campaigns in this window.</p>
      ) : (
        <div className="grid grid-cols-1 gap-2">
          {pageRows.map((c, i) => {
            const isThin = c.calls < MIN_RANK;
            const rank = (safePage - 1) * LEADERBOARD_PAGE_SIZE + i + 1;
            const fmt = formatCampaign(c.name);
            return (
              <button
                key={c.id}
                type="button"
                onClick={() => setDetailFor(c)}
                title="View campaign details & prompt"
                className={`group w-full text-left flex items-center gap-2.5 bg-[var(--bg-card)] border border-[var(--border)] rounded-lg px-3 py-1.5 cursor-pointer transition hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] ${isThin ? "opacity-50" : ""}`}
              >
                <RankBadge rank={rank} medal={!isThin} />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-[var(--text-1)] truncate group-hover:text-blue-400 transition-colors" title={c.name}>{fmt.display}</div>
                  <div className="text-[10px] text-[var(--text-3)] truncate">
                    {baseAgentName(c.baseAssistantId) ?? "—"} · {c.calls.toLocaleString()} calls
                  </div>
                </div>
                <div className="font-mono text-sm font-semibold text-amber-400 shrink-0">{pct(c.successRate)}</div>
              </button>
            );
          })}
        </div>
      )}
      {ordered.length > LEADERBOARD_PAGE_SIZE && (
        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          totalItems={ordered.length}
          pageSize={LEADERBOARD_PAGE_SIZE}
          onPageChange={setPage}
          noun="campaigns"
        />
      )}
      {detailFor && (
        <CampaignDetailsModal
          campaignId={detailFor.id}
          name={detailFor.name}
          country={detailFor.country}
          status={detailFor.status}
          baseAssistantId={detailFor.baseAssistantId}
          metrics={{ calls: detailFor.calls, connectRate: detailFor.connectRate, successRate: detailFor.successRate }}
          metricsLabel={`Last ${rangeDays}d`}
          onClose={() => setDetailFor(null)}
          onFilter={() => onFocusCampaign(detailFor.id)}
        />
      )}
    </section>
  );
}

function PromptTable({ prompts }: { prompts: PromptRow[] }) {
  const [sort, setSort] = useState<SortKey>("success");
  const [promptFor, setPromptFor] = useState<{ campaignId: string; title: string } | null>(null);
  const [page, setPage] = useState(1);
  const baseAgentName = useBaseAgentNames();
  const { qualified, thin } = rankOrder(prompts, sort);
  const ordered = [...qualified, ...thin];
  const totalPages = Math.max(1, Math.ceil(ordered.length / PROMPT_PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = ordered.slice((safePage - 1) * PROMPT_PAGE_SIZE, safePage * PROMPT_PAGE_SIZE);

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5 grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <FileText size={15} className="text-[var(--text-3)]" />
          <h3 className="text-[15px] font-semibold">Prompt Performance</h3>
        </div>
        <SortControl sort={sort} setSort={(s) => { setSort(s); setPage(1); }} />
      </div>
      {ordered.length === 0 ? (
        <p className="text-xs text-[var(--text-3)] py-4 text-center">No prompt data in this window.</p>
      ) : (
        <div className="grid gap-1.5">
          <div className="flex items-center gap-3 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-3)] border-b border-[var(--border)] mb-1">
            <span className="w-6" />
            <span className="flex-1">Prompt</span>
            <span className="w-14 text-right">Calls</span>
            <span className="w-14 text-right">Connect</span>
            <span className="w-14 text-right">Success</span>
          </div>
          {pageRows.map((p, i) => {
            const isThin = p.calls < MIN_RANK;
            const rank = (safePage - 1) * PROMPT_PAGE_SIZE + i + 1; // global rank across pages
            const sha4 = (p.sha ?? "").slice(0, 4);
            const composed = promptAgentLabel(baseAgentName(p.baseAssistantId), p.label);
            // The label fills + truncates to the row width (no dead gap before the metrics); the sha
            // moves to the subtitle so truncation never hides the one bit that distinguishes prompts.
            const suffix = ` · ${sha4}`;
            const main = composed.endsWith(suffix) ? composed.slice(0, -suffix.length) : composed;
            return (
              <div key={p.sha} className={`flex items-center gap-3 py-1.5 ${isThin ? "opacity-50" : ""}`}>
                <RankBadge rank={rank} medal={!isThin} />
                <div className="flex-1 min-w-0">
                  {p.campaignId ? (
                    <button
                      type="button"
                      onClick={() => setPromptFor({ campaignId: p.campaignId!, title: `${baseAgentName(p.baseAssistantId) ?? "Prompt"} · ${sha4}` })}
                      title="View full prompt"
                      className="block w-full text-left text-xs font-medium text-[var(--text-1)] hover:text-blue-400 transition-colors font-mono break-words line-clamp-2 cursor-pointer"
                    >
                      {main}
                    </button>
                  ) : (
                    <div className="text-xs font-medium text-[var(--text-1)] font-mono break-words line-clamp-2" title={composed}>{main}</div>
                  )}
                  <div className="text-[10px] text-[var(--text-3)]">
                    <span className="font-mono">{sha4}</span> · {p.campaignCount} campaign{p.campaignCount === 1 ? "" : "s"}
                  </div>
                </div>
                <div className="font-mono text-xs text-[var(--text-2)] w-14 text-right">{p.calls.toLocaleString()}</div>
                <div className="font-mono text-xs text-emerald-400 w-14 text-right">{pct(p.connectRate)}</div>
                <div className="font-mono text-xs text-amber-400 w-14 text-right">{pct(p.successRate)}</div>
              </div>
            );
          })}
        </div>
      )}
      {ordered.length > PROMPT_PAGE_SIZE && (
        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          totalItems={ordered.length}
          pageSize={PROMPT_PAGE_SIZE}
          onPageChange={setPage}
          noun="prompts"
        />
      )}
      {promptFor && (
        <PromptModal campaignId={promptFor.campaignId} title={promptFor.title} onClose={() => setPromptFor(null)} />
      )}
    </section>
  );
}

export default function RankedTables({
  agents,
  campaigns,
  prompts,
  rangeDays,
  onFocusCampaign,
}: {
  agents: AgentRow[];
  campaigns: CampaignLbRow[];
  prompts: PromptRow[];
  rangeDays: number;
  onFocusCampaign: (id: string) => void;
}) {
  return (
    // items-start: each column sizes to its own content (no stretch-spreading the shorter side).
    // Left column stacks Voice Agent + Top Campaigns so they fill the space beside the taller
    // Prompt panel; all three paginate to stay compact + balanced.
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start">
      <div className="grid gap-3.5">
        <AgentTable agents={agents} />
        <Leaderboard campaigns={campaigns} rangeDays={rangeDays} onFocusCampaign={onFocusCampaign} />
      </div>
      <PromptTable prompts={prompts} />
    </div>
  );
}
