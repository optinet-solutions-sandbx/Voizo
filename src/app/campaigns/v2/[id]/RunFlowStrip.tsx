"use client";

// Read-only "dialing flow" strip for the campaign detail page. Shows where a running (or
// paused) campaign is in its list — now dialing, up next, progress, next retry window — all
// DERIVED from the campaign_numbers_v2 rows the page already loads (no extra fetch). It
// DISPLAYS state the dialer owns; it never selects or fires anything. Logic: campaignRunFlow.ts.

import { useMemo } from "react";
import { PhoneCall, ChevronRight, Clock } from "lucide-react";
import { deriveRunFlow, type RunFlowNumber } from "@/lib/campaignRunFlow";

function fmtTime(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

export default function RunFlowStrip({
  numbers,
  maxAttempts,
  status,
  nowMs,
}: {
  numbers: Record<string, unknown>[];
  maxAttempts: number;
  status: string;
  // Stamped by the parent when it last synced the data (so this component stays pure — no
  // Date.now() during render). Used only for retry-window math.
  nowMs: number;
}) {
  const running = status === "running";
  const flow = useMemo(
    () => deriveRunFlow(numbers as unknown as RunFlowNumber[], { maxAttempts, nowMs }),
    [numbers, maxAttempts, nowMs],
  );

  const pctDone = flow.total > 0 ? Math.round((flow.done / flow.total) * 100) : 0;
  const retryAt = fmtTime(flow.nextRetryAt);

  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 mb-4">
      {/* Live / paused state + now-dialing + up-next */}
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 text-xs">
          {running ? (
            <span className="inline-flex items-center gap-1.5 font-semibold text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" /> LIVE
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 font-semibold text-amber-400">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400" /> Paused
            </span>
          )}
          <span className="text-[var(--text-3)]">·</span>
          {running && flow.nowDialing ? (
            <span className="inline-flex items-center gap-1.5 text-[var(--text-2)]">
              <PhoneCall size={12} className="text-emerald-400" />
              Now dialing <span className="font-mono text-[var(--text-1)]">{flow.nowDialing.phone}</span>
            </span>
          ) : (
            <span className="text-[var(--text-3)]">{running ? "Between calls…" : "Not dialing"}</span>
          )}
        </div>
        {flow.upNext && (
          <span
            className="inline-flex items-center gap-1 text-xs text-[var(--text-2)]"
            title="The next number the dialer will call. Same order the dialer uses (fresh pending first, then due retries by window time). It re-checks the do-not-call list at dial time."
          >
            <ChevronRight size={12} className="text-[var(--text-3)]" />
            {running ? "Up next" : "Resumes with"}{" "}
            <span className="font-mono text-[var(--text-1)]">{flow.upNext.phone}</span>
          </span>
        )}
      </div>

      {/* Progress through the list */}
      <div className="h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
        <div className="h-full rounded-full bg-blue-500 transition-all" style={{ width: `${pctDone}%` }} />
      </div>

      <div className="flex items-center gap-x-4 gap-y-1 flex-wrap mt-2 text-[11px] text-[var(--text-3)]">
        <span>
          <span className="font-semibold text-[var(--text-2)]">{flow.done.toLocaleString()}</span> of{" "}
          {flow.total.toLocaleString()} contacts done
        </span>
        <span>
          <span className="font-semibold text-[var(--text-2)]">{flow.pending.toLocaleString()}</span> pending
        </span>
        <span>
          <span className="font-semibold text-amber-400">{flow.awaitingRetry.toLocaleString()}</span> awaiting retry
          {flow.dueNow > 0 && (
            <span className="text-[var(--text-2)]"> ({flow.dueNow.toLocaleString()} due now)</span>
          )}
        </span>
        {running && flow.inProgress > 0 && (
          <span>
            <span className="font-semibold text-emerald-400">{flow.inProgress}</span> in progress
          </span>
        )}
        {retryAt && (
          <span className="inline-flex items-center gap-1">
            <Clock size={11} /> next retry window {retryAt}
          </span>
        )}
      </div>
    </div>
  );
}
