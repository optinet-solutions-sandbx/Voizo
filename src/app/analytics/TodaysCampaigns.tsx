"use client";

// Today's campaigns (Val's mockup, Slice A) — replaces the running-campaign stat cards with an
// expandable per-campaign ROW list. Each row: campaign + agent + view-prompt + chips (country/players/
// start date), a Running badge + runtime, and three compact BreakdownColumns (Call attempts / Reached /
// SMS, per-campaign TODAY). Expanding a row reuses the shipped CampaignExpand (records + CSV/Audio/
// Transcripts + view-prompt), lazily fetching that campaign's analytics. Rendered only when campaigns
// are running (DashboardView keeps the "none running" line). Data: TodaySnapshot.runningCampaigns.

import { useCallback, useState } from "react";
import { ChevronRight, Flag, Users, Calendar } from "lucide-react";
import type { RunningCampaignCard } from "@/lib/dashboardAnalytics";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";
import BreakdownColumn from "./BreakdownColumn";
import CampaignExpand from "@/components/analytics/CampaignExpand";
import PromptModal from "./PromptModal";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// "2026-06-27..." → "27 Jun" (UTC, locale-independent — avoids hydration drift).
function fmtDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
// Elapsed-so-far runtime ("45m" / "6h 12m" / "1d 3h") from a running campaign's start. Client-only
// (this is a "use client" tree rendered after the client data load — no SSR hydration concern).
function fmtRuntime(startIso: string | null): string | null {
  if (!startIso) return null;
  const startMs = Date.parse(startIso);
  if (!Number.isFinite(startMs)) return null;
  const totalMin = Math.floor((Date.now() - startMs) / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

const GRID = "grid grid-cols-[minmax(220px,1.6fr)_minmax(110px,auto)_repeat(3,minmax(150px,1fr))] gap-4";

export default function TodaysCampaigns({ campaigns }: { campaigns: RunningCampaignCard[] }) {
  const baseAgentName = useBaseAgentNames();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [analytics, setAnalytics] = useState<Record<string, CampaignAnalytics | null>>({});
  const [promptFor, setPromptFor] = useState<{ id: string; title: string } | null>(null);

  const fetchAnalytics = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/dashboard/campaigns/${id}/analytics`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { analytics: CampaignAnalytics | null };
      setAnalytics((prev) => ({ ...prev, [id]: body.analytics }));
    } catch {
      setAnalytics((prev) => ({ ...prev, [id]: null })); // degrade loudly in the UI, not silently
    }
  }, []);

  const toggleExpand = (id: string) => {
    const willExpand = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willExpand && analytics[id] === undefined) fetchAnalytics(id);
  };

  if (campaigns.length === 0) return null;

  // Most active today first.
  const rows = [...campaigns].sort((a, b) => b.perf.callAttempts.total - a.perf.callAttempts.total);

  return (
    <section className="grid gap-2">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[920px]">
            {/* Header */}
            <div className={`${GRID} px-4 py-3 border-b border-[var(--border)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]`}>
              <div>Today&apos;s campaigns</div>
              <div>Status</div>
              <div>Call attempts</div>
              <div>Reached</div>
              <div>SMS sent</div>
            </div>

            {rows.map((c) => {
              const fmt = formatCampaign(c.name);
              const runtime = fmtRuntime(c.startAt);
              const isOpen = expanded.has(c.id);
              return (
                <div key={c.id} className="border-b border-[var(--border)] last:border-b-0">
                  <div className={`${GRID} px-4 py-3 items-start hover:bg-[var(--bg-hover)]/40 transition-colors`}>
                    {/* Campaign */}
                    <div className="min-w-0">
                      <button
                        type="button"
                        onClick={() => toggleExpand(c.id)}
                        className="flex items-center gap-1.5 text-left min-w-0 group"
                        aria-label={isOpen ? "Collapse call records" : "Expand call records"}
                      >
                        <ChevronRight size={14} className={`text-[var(--text-3)] shrink-0 transition-transform ${isOpen ? "rotate-90" : ""}`} />
                        <span className="text-sm font-semibold text-[var(--text-1)] truncate group-hover:text-blue-400 transition-colors" title={c.name}>
                          {fmt.offer || fmt.display}
                        </span>
                      </button>
                      <div className="text-[11px] text-[var(--text-3)] mt-1 flex items-center gap-1.5 flex-wrap">
                        <span>{baseAgentName(c.baseAssistantId) ?? voiceName(c.voiceId, { short: true }) ?? "—"}</span>
                        <span className="text-[var(--border-2)]">·</span>
                        <button
                          type="button"
                          onClick={() => setPromptFor({ id: c.id, title: fmt.display })}
                          className="text-blue-400 hover:text-blue-300 transition-colors"
                        >
                          view prompt
                        </button>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap mt-1.5 text-[10px] text-[var(--text-3)]">
                        {c.country !== "UNKNOWN" && (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)]">
                            <Flag size={10} /> {c.country}
                          </span>
                        )}
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
                          <Users size={10} /> {c.players.toLocaleString()} players
                        </span>
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--bg-elevated)]">
                          <Calendar size={10} /> {fmtDay(c.startAt)}
                        </span>
                      </div>
                    </div>

                    {/* Status + runtime */}
                    <div className="flex flex-col gap-1">
                      <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] font-medium bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 w-fit">
                        <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> Running
                      </span>
                      {runtime && <span className="text-[10px] font-mono text-[var(--text-3)]">{runtime}</span>}
                    </div>

                    {/* Breakdown columns */}
                    <BreakdownColumn metric={c.perf.callAttempts} />
                    <BreakdownColumn metric={c.perf.reached} />
                    <BreakdownColumn metric={c.perf.sms} />
                  </div>

                  {isOpen && (
                    <div className="px-4 py-4 bg-[var(--bg-app)] border-t border-[var(--border)]">
                      {analytics[c.id] === undefined ? (
                        <p className="text-xs text-[var(--text-3)] py-2">Loading campaign analytics…</p>
                      ) : analytics[c.id] === null ? (
                        <p className="text-xs text-[var(--text-3)] py-2">No analytics available for this campaign.</p>
                      ) : (
                        <CampaignExpand a={analytics[c.id]!} />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {promptFor && <PromptModal campaignId={promptFor.id} title={promptFor.title} onClose={() => setPromptFor(null)} />}
    </section>
  );
}
