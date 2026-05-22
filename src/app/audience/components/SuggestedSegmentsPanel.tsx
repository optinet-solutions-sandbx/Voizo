"use client";

import { ArrowRight, Sparkles } from "lucide-react";

/**
 * SuggestedSegmentsPanel — proactive worklist for the Audience tab.
 *
 * Rendered above the committed-segments list when /api/audience/suggestions
 * returns at least one candidate. Cards are informational; clicking "Carve
 * segment →" opens the existing CreateSegmentDrawer pre-filled with the
 * source + conservative outcome defaults. Operator can tweak before
 * committing — no auto-soft-mark, no destructive side effects.
 *
 * Design: docs/2026-05-22_DOC_Audience_Suggestions_MVP.md §5.3
 */

export interface SuggestionCandidates {
  pending: number;
  pending_retry: number;
  total: number;
}

export interface SuggestionDefaults {
  name: string;
  outcomes_included: string[];
  dnc_scrubbed: boolean;
  recent_window_days: number;
}

export interface Suggestion {
  source_campaign_id: string;
  source_campaign_name: string;
  source_status: string;
  candidates: SuggestionCandidates;
  last_dialed_at: string | null;
  suggested_defaults: SuggestionDefaults;
}

interface Props {
  suggestions: Suggestion[];
  onCarve: (suggestion: Suggestion) => void;
}

const STATUS_BADGE: Record<string, string> = {
  paused:    "bg-amber-500/12 text-amber-400 border-amber-500/30",
  completed: "bg-emerald-500/12 text-emerald-400 border-emerald-500/30",
  archived:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
  inactive:  "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]",
};

function formatRelative(ts: string | null, now: Date): string {
  if (!ts) return "never";
  const diffMs = now.getTime() - new Date(ts).getTime();
  if (diffMs < 0) return "just now";
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

export default function SuggestedSegmentsPanel({ suggestions, onCarve }: Props) {
  if (suggestions.length === 0) return null;
  const now = new Date();

  return (
    <div className="rounded-2xl border border-indigo-500/25 bg-indigo-500/[0.04] p-4 mb-4">
      <div className="flex items-center gap-2 mb-3">
        <Sparkles size={15} className="text-indigo-400" />
        <h2 className="text-sm font-semibold text-[var(--text-1)]">
          Suggested for recycling ({suggestions.length})
        </h2>
        <span className="text-[11px] text-[var(--text-3)] ml-1">
          finished campaigns with phones ready to recycle
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2.5">
        {suggestions.map((s) => {
          const statusClass =
            STATUS_BADGE[s.source_status] ??
            "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]";

          return (
            <div
              key={s.source_campaign_id}
              className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 flex flex-col gap-2"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-[var(--text-1)] truncate" title={s.source_campaign_name}>
                    {s.source_campaign_name}
                  </p>
                  <p className="text-[11px] text-[var(--text-3)] mt-0.5">
                    Last dialed {formatRelative(s.last_dialed_at, now)}
                  </p>
                </div>
                <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] uppercase tracking-wide border ${statusClass}`}>
                  {s.source_status}
                </span>
              </div>

              <div className="flex flex-wrap gap-1.5 text-[11px]">
                {s.candidates.pending > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-[var(--bg-app)] text-[var(--text-2)] border border-[var(--border)]">
                    <span className="font-semibold">{s.candidates.pending}</span> Pending
                  </span>
                )}
                {s.candidates.pending_retry > 0 && (
                  <span className="px-2 py-0.5 rounded-full bg-amber-500/12 text-amber-400 border border-amber-500/30">
                    <span className="font-semibold">{s.candidates.pending_retry}</span> Awaiting retry
                  </span>
                )}
                <span className="ml-auto text-[var(--text-3)] self-center">
                  {s.candidates.total} total recyclable
                </span>
              </div>

              <button
                onClick={() => onCarve(s)}
                className="inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-medium transition-colors"
              >
                Carve segment <ArrowRight size={13} />
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
