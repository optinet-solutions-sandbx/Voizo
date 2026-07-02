"use client";

// Today's campaigns (Val's mockup, Slice A) — expandable per-campaign rows for today's running campaigns,
// rendered via the shared CampaignRow (Slice C). Each row: campaign + agent + view-prompt + chips
// (country/players/date), a Running badge + runtime, and three compact BreakdownColumns (per-campaign
// TODAY). Straight-to-records (2026-07-02): expanding goes directly to the records; clicking a
// breakdown number opens them pre-filtered to that slice (mockup handleRowClick semantics).
// Rendered only when campaigns are running. Data: TodaySnapshot.runningCampaigns.

import { useState } from "react";
import type { RunningCampaignCard } from "@/lib/dashboardAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import { useExpandSlices } from "./useExpandSlices";
import CampaignRow, { CAMPAIGN_ROW_GRID, type CampaignRowData } from "./CampaignRow";
import PromptModal from "./PromptModal";

// Elapsed-so-far runtime ("45m" / "6h 12m" / "1d 3h") from a running campaign's start. Client-only
// (this "use client" tree renders after the client data load — no SSR hydration concern).
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

export default function TodaysCampaigns({ campaigns }: { campaigns: RunningCampaignCard[] }) {
  // Expand + per-row slice state (straight-to-records) — shared hook (mockup semantics).
  const { expanded, slices, toggleExpand, pickMetric, clearSlice } = useExpandSlices();
  const [promptFor, setPromptFor] = useState<{ id: string; title: string } | null>(null);

  if (campaigns.length === 0) return null;

  // Most active today first.
  const rows = [...campaigns].sort((a, b) => b.perf.callAttempts.total - a.perf.callAttempts.total);

  return (
    <section className="grid gap-2">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <div className="min-w-[920px]">
            {/* Header */}
            <div className={`${CAMPAIGN_ROW_GRID} px-4 py-3 border-b border-[var(--border)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]`}>
              <div>Today&apos;s campaigns</div>
              <div>Status</div>
              <div>Call attempts</div>
              <div>Reached</div>
              <div>SMS sent</div>
            </div>

            {rows.map((c) => {
              const data: CampaignRowData = {
                id: c.id,
                name: c.name,
                country: c.country,
                voiceId: c.voiceId,
                agentLabel: c.agentLabel,
                baseAssistantId: c.baseAssistantId,
                scheduleType: c.scheduleType,
                status: "running",
                timeLabel: fmtRuntime(c.startAt) ?? "",
                players: c.players,
                startAt: c.startAt,
                perf: c.perf,
              };
              return (
                <CampaignRow
                  key={c.id}
                  c={data}
                  expanded={expanded.has(c.id)}
                  onToggle={() => toggleExpand(c.id)}
                  slice={slices[c.id]?.slice}
                  sliceLabel={slices[c.id]?.label}
                  onMetricPick={(s, l) => pickMetric(c.id, s, l)}
                  onClearSlice={() => clearSlice(c.id)}
                  onViewPrompt={() => setPromptFor({ id: c.id, title: formatCampaign(c.name).display })}
                />
              );
            })}
          </div>
        </div>
      </div>

      {promptFor && <PromptModal campaignId={promptFor.id} title={promptFor.title} onClose={() => setPromptFor(null)} />}
    </section>
  );
}
