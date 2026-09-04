"use client";

// Today's campaigns (Val's mockup, Slice A) — expandable per-campaign rows for today's running campaigns,
// rendered via the shared CampaignRow (Slice C). Each row: campaign + agent + view-prompt + chips
// (country/players/date), a Running badge + runtime, and three compact metric cells (per-campaign
// TODAY). Straight-to-records (2026-07-02): expanding goes directly to the records; clicking a
// breakdown number opens them pre-filtered to that slice (mockup handleRowClick semantics).
// Rendered only when campaigns are running. Data: TodaySnapshot.runningCampaigns.

import { useState } from "react";
import type { RunningCampaignCard } from "@/lib/dashboardAnalytics";
import { formatCampaign, brandLabel, campaignGroupHeaderLabels, campaignShortLabel } from "@/lib/campaignDisplay";
import { playOf, runOrdinals } from "./campaignGrouping";
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

  // Recurring PARENTS are schedules, not dialers (Jasiel 2026-08-07): they sat
  // here as permanent all-zero "Scheduled" rows — pure clutter in a list about
  // today's dialing. They keep their home on /campaigns (Always-on section);
  // their CHILDREN appear here as their own rows when they dial.
  const rows = campaigns
    .filter((c) => c.scheduleType !== "recurring")
    .sort((a, b) => b.perf.callAttempts.total - a.perf.callAttempts.total);

  // Val's law, from the mockup (2026-09-03): a Today row is named by its LANE, Brand · Market ·
  // Play, because that is what dials and what breaks. The brand leads only when more than one
  // brand is live (under one brand it is constant and says nothing); the play comes from the
  // family's header label with country and brand stripped; a run with no family keeps its own
  // name. The chip strip is hidden here: every chip restated the title. Same-day twins carry
  // "run 1 of 2", counted over every running row so the pair is always numbered together.
  const parentLabel = campaignGroupHeaderLabels(
    campaigns.filter((c) => c.scheduleType === "recurring").map((c) => ({ id: c.id, name: c.name, brand: c.cioWorkspace, startAt: c.startAt })),
  );
  const brandsLive = new Set(rows.map((c) => brandLabel(c.cioWorkspace))).size;
  const laneLabelOf = (c: RunningCampaignCard): string => {
    const label = c.parentCampaignId ? parentLabel.get(c.parentCampaignId) : null;
    const brand = brandLabel(c.cioWorkspace);
    // The country the label carries is the NAME ("Australia"); c.country is the token ("AU").
    // Use the name so the row reads like the lane cards above it, and so a play tail that still
    // carries "AU" does not sit next to a second "AU".
    const country = formatCampaign(c.name).country || c.country;
    // A run with no family is named from itself, through the same stripping, so the country and
    // brand are not said twice.
    const play = playOf(label || campaignShortLabel(c.name), country, brand);
    // Joined, not concatenated: a campaign whose name carries no country and no play would
    // otherwise leave a dangling separator in the row's only label.
    return [brandsLive > 1 ? brand : "", country, play].filter(Boolean).join(" · ");
  };
  const ordinals = runOrdinals(rows.map((c) => ({ ...c, attempts: c.perf.callAttempts.total, conversations: c.perf.reached.total, sms: c.perf.sms.total, displayStatus: "running" as const })));

  if (rows.length === 0) return null;

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
              <div>Conversations est.</div>
              <div>SMS sent</div>
            </div>

            {rows.map((c) => {
              // A recurring PARENT is a schedule, not a dialer — its DB status is
              // 'running' but it makes no calls (its children do, as their own
              // rows). Show it as "Scheduled" and drop the misleading "running
              // for Xh" runtime. Fixed campaigns and children stay "Running".
              const isSchedule = c.scheduleType === "recurring";
              const data: CampaignRowData = {
                id: c.id,
                name: c.name,
                country: c.country,
                cioWorkspace: c.cioWorkspace,
                voiceId: c.voiceId,
                agentLabel: c.agentLabel,
                baseAssistantId: c.baseAssistantId,
                scheduleType: c.scheduleType,
                status: isSchedule ? "scheduled" : "running",
                timeLabel: isSchedule ? "" : (fmtRuntime(c.startAt) ?? ""),
                players: c.players,
                startAt: c.startAt,
                perf: c.perf,
                titleOverride: laneLabelOf(c),
                runOrdinal: ordinals.get(c.id) || undefined,
                hideChips: true,
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
