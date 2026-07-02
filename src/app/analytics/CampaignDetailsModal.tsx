"use client";

// Rich campaign drill-down (2026-06-16, Val's-mockup parity). Opened from a Today's-Performance
// running card or a Top-Performing-Campaigns leaderboard row. Shows the campaign header, a meta
// grid (voice agent · status · calls/connect/success), the system prompt it ran (shared
// PromptVersionsPanel = "Val's proposal"), and an optional "Filter dashboard to this campaign".

import { useEffect, type ReactNode } from "react";
import { X, Megaphone, Filter } from "lucide-react";
import { formatCampaign } from "@/lib/campaignDisplay";
import { useBaseAgentNames } from "./useBaseAgentNames";
import PromptVersionsPanel from "./PromptVersionsPanel";

export interface CampaignDetailMetrics {
  calls: number;
  connectRate: number | null;
  reach: number;
  positiveResponseRate: number | null;
  smsSent?: number; // only the leaderboard path carries SMS; the running-card RateRow doesn't
}

const pct = (n: number | null) => (n === null ? "—" : `${(n * 100).toFixed(1)}%`);

// raw campaigns_v2.status → pill label + classes. Unknown values fall back to a muted capitalize.
const STATUS_PILL: Record<string, { label: string; cls: string }> = {
  running: { label: "Running", cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  paused: { label: "Paused", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  completed: { label: "Completed", cls: "text-primary bg-primary/10 border-primary/20" },
  inactive: { label: "Inactive", cls: "text-[var(--text-3)] bg-[var(--bg-elevated)] border-[var(--border)]" },
  draft: { label: "Draft", cls: "text-[var(--text-3)] bg-[var(--bg-elevated)] border-[var(--border)]" },
};
function statusPill(raw: string) {
  return (
    STATUS_PILL[raw?.toLowerCase()] ?? {
      label: raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "—",
      cls: "text-[var(--text-3)] bg-[var(--bg-elevated)] border-[var(--border)]",
    }
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">{label}</div>
      <div className="text-sm font-medium text-[var(--text-1)] mt-0.5">{children}</div>
    </div>
  );
}

export default function CampaignDetailsModal({
  campaignId,
  name,
  country,
  status,
  baseAssistantId,
  metrics,
  metricsLabel,
  onClose,
  onFilter,
}: {
  campaignId: string;
  name: string;
  country: string;
  status: string;
  baseAssistantId: string | null;
  metrics: CampaignDetailMetrics;
  metricsLabel: string; // "Today" / "Last 30d" — what window the metrics cover
  onClose: () => void;
  onFilter?: () => void;
}) {
  const baseAgentName = useBaseAgentNames();
  const fmt = formatCampaign(name);
  const pill = statusPill(status);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60" onClick={onClose}>
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[var(--text-1)]">
              <Megaphone size={15} className="shrink-0 text-[var(--text-3)]" />
              {country && country !== "UNKNOWN" && (
                <span className="text-[9px] font-bold font-mono px-1.5 py-0.5 rounded bg-[var(--bg-elevated)] text-[var(--text-2)] shrink-0">
                  {country}
                </span>
              )}
              <span className="font-semibold truncate" title={name}>
                {fmt.offer || fmt.display}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-3)] font-mono mt-1 truncate" title={name}>
              {name}
            </p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        {/* Meta grid */}
        <div className="flex flex-wrap gap-x-7 gap-y-3 px-5 py-4 border-b border-[var(--border)] bg-[var(--bg-app)]">
          <Meta label="Voice agent">{baseAgentName(baseAssistantId) ?? "—"}</Meta>
          <Meta label="Status">
            <span className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full border ${pill.cls}`}>
              {status?.toLowerCase() === "running" && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
              {pill.label}
            </span>
          </Meta>
          <Meta label={`Calls · ${metricsLabel}`}>
            <span className="font-mono">{metrics.calls.toLocaleString()}</span>
          </Meta>
          <Meta label="Connect">
            <span className="font-mono text-emerald-400">{pct(metrics.connectRate)}</span>
          </Meta>
          <Meta label="Reached">
            <span className="font-mono text-teal-400">{metrics.reach.toLocaleString()}</span>
          </Meta>
          {metrics.smsSent != null && (
            <Meta label="SMS sent">
              <span className="font-mono text-primary">{metrics.smsSent.toLocaleString()}</span>
            </Meta>
          )}
          <Meta label="Positive response">
            <span className="font-mono text-amber-400">{pct(metrics.positiveResponseRate)}</span>
          </Meta>
        </div>

        {/* Prompt ("Val's proposal") */}
        <div className="px-5 py-4 overflow-y-auto">
          <p className="text-[10px] uppercase tracking-wider text-[var(--text-3)] mb-2">Prompt</p>
          <PromptVersionsPanel campaignId={campaignId} />
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <button
            onClick={onClose}
            className="text-xs font-medium text-[var(--text-2)] hover:text-[var(--text-1)] px-3 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] hover:bg-[var(--bg-hover)] transition"
          >
            Close
          </button>
          {onFilter && (
            <button
              onClick={() => {
                onFilter();
                onClose();
              }}
              className="inline-flex items-center gap-1.5 text-xs font-medium text-white px-3 py-1.5 rounded-lg bg-primary hover:bg-primary transition shadow-sm shadow-primary/20"
            >
              <Filter size={12} /> Filter dashboard to this campaign
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
