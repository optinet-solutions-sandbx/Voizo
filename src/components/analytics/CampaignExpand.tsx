"use client";

// The content of an expanded campaigns-list row. Leads with the legible CampaignSummary, then
// progressive-disclosure drill-ins (call records, the prompt that ran, the engineer-grade deep
// dive) + the always-useful actions (per-campaign export, open the campaign). Records/advanced
// are toggles so the default stays compact; "View prompt" opens a modal.

import { useState } from "react";
import Link from "next/link";
import { Download, ChevronDown, ListChecks, FileText } from "lucide-react";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { triggerDownload } from "@/lib/download";
import { buildAnalyticsCsv, buildAnalyticsJson } from "@/lib/analyticsExport";
import { formatCampaign } from "@/lib/campaignDisplay";
import CampaignSummary from "./CampaignSummary";
import AnalyticsRowExpand from "./AnalyticsRowExpand";
import CallRecords from "@/app/analytics/CallRecords";
import PromptModal from "@/app/analytics/PromptModal";

const toggleCls =
  "inline-flex items-center gap-1.5 rounded-lg border border-[var(--border)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]";
const exportCls =
  "inline-flex items-center gap-1.5 rounded-md bg-[var(--bg-elevated)] px-2.5 py-1.5 text-xs font-medium text-[var(--text-2)] transition hover:text-[var(--text-1)]";

export default function CampaignExpand({ a }: { a: CampaignAnalytics }) {
  const [advanced, setAdvanced] = useState(false);
  const [showRecords, setShowRecords] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);

  return (
    <div className="grid gap-4">
      <CampaignSummary a={a} />

      {/* Drill-ins (left) + export / open (right). */}
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" onClick={() => setShowRecords((v) => !v)} className={toggleCls}>
          <ListChecks size={13} /> {showRecords ? "Hide call records" : "Call records"}
        </button>
        <button type="button" onClick={() => setPromptOpen(true)} className={toggleCls}>
          <FileText size={13} /> View prompt
        </button>
        <button type="button" onClick={() => setAdvanced((v) => !v)} className={toggleCls}>
          <ChevronDown size={13} className={`transition-transform ${advanced ? "rotate-180" : ""}`} />
          {advanced ? "Hide advanced" : "Advanced analytics"}
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

      {showRecords && <CallRecords campaignId={a.id} />}

      {advanced && (
        <div className="border-t border-[var(--border)] pt-4">
          <AnalyticsRowExpand a={a} />
        </div>
      )}

      {promptOpen && (
        <PromptModal campaignId={a.id} title={formatCampaign(a.name).display} onClose={() => setPromptOpen(false)} />
      )}
    </div>
  );
}
