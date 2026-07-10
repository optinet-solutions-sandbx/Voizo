"use client";

// Prompt viewer modal (Slice 4) — shows the actual system_prompt a campaign ran. Thin modal
// chrome around the shared PromptVersionsPanel (extracted 2026-06-16 so CampaignDetailsModal
// reuses the same viewer). Opened from the Prompt Performance table (sha-centric drill-down).

import { useEffect } from "react";
import { X, FileText } from "lucide-react";
import PromptVersionsPanel from "./PromptVersionsPanel";

export default function PromptModal({
  campaignId,
  title,
  onClose,
}: {
  campaignId: string;
  title: string;
  onClose: () => void;
}) {
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
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[var(--text-1)]">
              <FileText size={15} className="shrink-0" />
              <span className="font-semibold truncate">{title}</span>
            </div>
            <p className="text-[11px] text-[var(--text-3)] mt-1">The prompt this campaign ran, from saved snapshots.</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto">
          <PromptVersionsPanel campaignId={campaignId} />
        </div>
      </div>
    </div>
  );
}
