"use client";

// The content of an expanded campaigns-list row — records-FIRST (Val's mockup: the row's stat
// columns ARE the overview, so the expand is just the players behind the clicked number).
// CallRecords renders immediately, pre-filtered by the slice the parent row-click picked
// (the badge × clears the slice; collapsing is the row's job). Quiet trailing actions:
// Advanced analytics (per-campaign analytics fetched lazily on first open, or preloaded via
// `a` where the caller already has it) + "Open campaign →" (+ View prompt on surfaces whose
// row lacks the view-prompt link, e.g. /campaigns).

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, FileText } from "lucide-react";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import AnalyticsRowExpand from "./AnalyticsRowExpand";
import CallRecords from "@/app/analytics/CallRecords";
import PromptModal from "@/app/analytics/PromptModal";
import { type RecordSlice } from "@/app/analytics/recordsDisplay";
import { BlockSkeleton } from "@/app/analytics/loadingSkeletons";

const quietCls =
  "inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] transition hover:text-[var(--text-2)]";

export default function CampaignExpand({
  campaignId,
  name,
  slice,
  sliceLabel,
  onClearSlice,
  a,
  viewPrompt = false,
}: {
  campaignId: string;
  name: string;
  slice?: RecordSlice; // pre-applied records filter from the row's clicked number
  sliceLabel?: string;
  onClearSlice?: () => void; // slice badge × — clears the filter, records stay open
  a?: CampaignAnalytics | null; // preloaded analytics (/campaigns page); omitted → lazy-fetch on Advanced
  viewPrompt?: boolean; // render a View-prompt button (for surfaces whose row lacks the link)
}) {
  const [advanced, setAdvanced] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  // Lazy analytics for the Advanced section (only when not preloaded): undefined = not
  // fetched/loading · null = unavailable (ghost/missing/error) · object = loaded.
  const [fetched, setFetched] = useState<CampaignAnalytics | null | undefined>(undefined);
  const analytics = a !== undefined ? a : fetched;

  // Fetch on the user's Advanced click (house pattern: imperative fetch in the handler, not an
  // effect) — the records-first expand itself never needs the analytics payload.
  const toggleAdvanced = () => {
    setAdvanced((v) => !v);
    if (!advanced && a === undefined && fetched === undefined) {
      fetch(`/api/dashboard/campaigns/${campaignId}/analytics`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const body = (await res.json()) as { analytics: CampaignAnalytics | null };
          setFetched(body.analytics);
        })
        .catch(() => setFetched(null)); // degrade loudly in the UI, not silently
    }
  };

  return (
    <div>
      {/* Records — the expand's whole point (mockup parity). Slice from the clicked number. */}
      <CallRecords campaignId={campaignId} slice={slice} sliceLabel={sliceLabel} onClose={onClearSlice} />

      {/* Quiet trailing actions (additive to the mockup's records-only expand). */}
      <div className="flex flex-wrap items-center gap-3 px-5 pb-4">
        <button type="button" onClick={toggleAdvanced} className={quietCls}>
          <ChevronDown size={11} className={`transition-transform ${advanced ? "rotate-180" : ""}`} />
          {advanced ? "Hide advanced analytics" : "Advanced analytics"}
        </button>
        <div className="ml-auto flex items-center gap-3">
          {viewPrompt && (
            <button type="button" onClick={() => setPromptOpen(true)} className={quietCls}>
              <FileText size={11} /> View prompt
            </button>
          )}
          <Link href={`/campaigns/v2/${campaignId}`} className="text-[11px] text-blue-400 transition hover:text-blue-300">
            Open campaign →
          </Link>
        </div>
      </div>

      {advanced && (
        <div className="border-t border-[var(--border)] px-5 py-4">
          {analytics === undefined ? (
            <BlockSkeleton lines={4} />
          ) : analytics === null ? (
            <p className="text-xs text-[var(--text-3)] py-2">No analytics available for this campaign.</p>
          ) : (
            <AnalyticsRowExpand a={analytics} />
          )}
        </div>
      )}

      {promptOpen && (
        <PromptModal campaignId={campaignId} title={formatCampaign(name).display} onClose={() => setPromptOpen(false)} />
      )}
    </div>
  );
}
