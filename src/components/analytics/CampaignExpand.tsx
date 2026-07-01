"use client";

// The content of an expanded campaigns-list row. Leads with the legible CampaignSummary, whose
// metrics/breakdown rows are click-to-filter: clicking one opens the inline records filtered to that
// slice (re-click or the badge × closes). Plus the always-useful actions (View prompt modal,
// per-campaign export, open the campaign) and a quiet "Advanced analytics" link for the deep dive.

import { useState } from "react";
import Link from "next/link";
import { Download, ChevronDown, FileText } from "lucide-react";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { triggerDownload } from "@/lib/download";
import { buildAnalyticsCsv, buildAnalyticsJson } from "@/lib/analyticsExport";
import { formatCampaign } from "@/lib/campaignDisplay";
import CampaignSummary from "./CampaignSummary";
import AnalyticsRowExpand from "./AnalyticsRowExpand";
import CallRecords from "@/app/analytics/CallRecords";
import PromptModal from "@/app/analytics/PromptModal";
import { type RecordSlice, sliceEq } from "@/app/analytics/recordsDisplay";

const toggleCls =
  "inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]";
const exportCls =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-2)] transition hover:text-[var(--text-1)]";

export default function CampaignExpand({ a }: { a: CampaignAnalytics }) {
  const [advanced, setAdvanced] = useState(false);
  const [pick, setPick] = useState<{ slice: RecordSlice; label: string } | null>(null);
  const [promptOpen, setPromptOpen] = useState(false);

  // Click a metric/breakdown row in the overview → open the records filtered to that slice;
  // click the same one again → close (toggle).
  const togglePick = (slice: RecordSlice, label: string) =>
    setPick((prev) => (prev && sliceEq(prev.slice, slice) ? null : { slice, label }));

  return (
    <div className="grid gap-4">
      {/* Overview — its metrics/breakdown rows are click-to-filter, driving the inline records below. */}
      <CampaignSummary a={a} onPick={togglePick} active={pick?.slice ?? null} />

      {/* Actions: View prompt (prominent) + per-campaign export / open (right). */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setPromptOpen(true)} className={toggleCls}>
          <FileText size={13} /> View prompt
        </button>

        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => {
              const csv = buildAnalyticsCsv([a]);
              triggerDownload(new Blob([csv], { type: "text/csv;charset=utf-8;" }), `voizo_analytics_${a.id}.csv`);
            }}
            className={exportCls}
          >
            <Download size={12} /> CSV
          </button>
          <button
            type="button"
            onClick={() => {
              const json = buildAnalyticsJson([a], new Date().toISOString());
              triggerDownload(new Blob([json], { type: "application/json" }), `voizo_analytics_${a.id}.json`);
            }}
            className={exportCls}
          >
            <Download size={12} /> JSON
          </button>
          <Link href={`/campaigns/v2/${a.id}`} className="text-xs text-blue-400 transition hover:text-blue-300">
            Open campaign →
          </Link>
        </div>
      </div>

      {/* Inline records — appears when a metric/row is clicked, filtered to that slice (× or re-click
          closes). Not keyed by slice: CallRecords filters reactively by the `slice` prop, so switching
          metrics re-filters instantly with no re-fetch (records are the same campaign). */}
      {pick && (
        <CallRecords campaignId={a.id} slice={pick.slice} sliceLabel={pick.label} onClose={() => setPick(null)} />
      )}

      {/* Advanced analytics — nice-to-have; quiet link at the bottom. */}
      <div>
        <button
          type="button"
          onClick={() => setAdvanced((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] transition hover:text-[var(--text-2)]"
        >
          <ChevronDown size={11} className={`transition-transform ${advanced ? "rotate-180" : ""}`} />
          {advanced ? "Hide advanced analytics" : "Advanced analytics"}
        </button>
        {advanced && (
          <div className="mt-2 border-t border-[var(--border)] pt-4">
            <AnalyticsRowExpand a={a} />
          </div>
        )}
      </div>

      {promptOpen && (
        <PromptModal campaignId={a.id} title={formatCampaign(a.name).display} onClose={() => setPromptOpen(false)} />
      )}
    </div>
  );
}
