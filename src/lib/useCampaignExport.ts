"use client";

import { useCallback, useRef, useState } from "react";
import { runExport, type ExportMode, type ExportProgress } from "./recordsExportEngine";
import type { ExportLead } from "./exportLeads";

/**
 * useCampaignExport
 *
 * Per-campaign export hook for the campaign detail page. Fetches the campaign's leads from
 * /api/campaigns-v2/[id]/export-metadata?type=<category>, then delegates the actual CSV / transcript /
 * audio compilation to the shared `runExport` engine (src/lib/recordsExportEngine.ts) — the same engine
 * the cross-campaign Global drawer uses. This hook owns only the campaign-scoped metadata source, the
 * download filenames, and the exporting/progress/error state.
 *
 * Category (`type`) and output shape (`mode`) are orthogonal: every category can be exported as csv,
 * audio, or transcripts.
 */

// Unified category taxonomy (mirrors the dashboardAnalytics AttemptTag contract, plus "all"). The
// export-metadata route tags each call via deriveAttemptTag and filters by the requested category.
export type ExportType =
  | "all"
  | "positive"
  | "neutral"
  | "declined"
  | "early_hangup"
  | "voicemail"
  | "unreachable";

// Re-exported for consumers (ExportMenu) that import the output shape from here.
export type { ExportMode } from "./recordsExportEngine";

export function useCampaignExport(campaignId: string) {
  const [exporting, setExporting] = useState(false);
  const [progress, setProgress] = useState<ExportProgress>({ current: 0, total: 0, stage: "" });
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const startExport = useCallback(
    async (type: ExportType, mode: ExportMode | boolean) => {
      // Normalize the legacy boolean (false → csv, true → audio) into the mode enum.
      const resolvedMode: ExportMode = typeof mode === "boolean" ? (mode ? "audio" : "csv") : mode;

      setExporting(true);
      setError(null);
      setProgress({ current: 0, total: 0, stage: "Fetching metadata..." });

      const ctrl = new AbortController();
      abortRef.current = ctrl;

      try {
        const res = await fetch(`/api/campaigns-v2/${campaignId}/export-metadata?type=${type}`, {
          signal: ctrl.signal,
        });
        if (!res.ok) throw new Error(`Metadata fetch returned HTTP ${res.status}`);
        const payload = await res.json();
        // Defensive: the endpoint could return `{error}` with HTTP 200; guard against `.length` on a non-array.
        const leads: ExportLead[] = Array.isArray(payload?.data) ? (payload.data as ExportLead[]) : [];
        if (leads.length === 0) throw new Error("No data matches this filter.");

        // SMS columns matter where a post-goal offer SMS can exist: the full export + the positive cut.
        const includeSmsCols = type === "all" || type === "positive";
        const safeType = type.replace(/_/g, "-");
        const shortId = campaignId.slice(0, 8);

        await runExport({
          leads,
          mode: resolvedMode,
          includeSmsCols,
          // Preserve the exact per-campaign download names (transcripts keeps its mid-name position).
          filename: (m) =>
            m === "transcripts"
              ? `voizo_${safeType}_transcripts_${shortId}.zip`
              : m === "csv"
                ? `voizo_${safeType}_${shortId}.csv`
                : `voizo_${safeType}_${shortId}.zip`,
          signal: ctrl.signal,
          onProgress: setProgress,
        });
      } catch (err) {
        if ((err as Error).name === "AbortError") setError("Export cancelled.");
        else setError(err instanceof Error ? err.message : "Export failed.");
      } finally {
        setExporting(false);
        abortRef.current = null;
      }
    },
    [campaignId],
  );

  return { startExport, cancel, exporting, progress, error };
}
