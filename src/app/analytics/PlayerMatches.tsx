"use client";

// Player search results (Jasiel 2026-09-03): one row per player, newest touch first, five shown
// and the rest behind one button. A click opens the player's popup (recordings, transcripts, and
// the runs they sat in, each with a way into its campaign). The table below is narrowed to the
// runs holding these players; the footer says so in one line.
import { useState } from "react";
import { ChevronRight, MessageSquare } from "lucide-react";
import type { Player } from "./playerGrouping";

const SHOWN = 5;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export const shortDate = (iso: string | null): string | null => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
};

export default function PlayerMatches({ query, players, campaignRuns, hiddenCount, truncated, onOpen, onClearFilters }: {
  query: string;
  players: Player[];
  /** Runs whose own name, family, brand or market matched the words (the table below shows them). */
  campaignRuns: number;
  /** Matches the current filters exclude. */
  hiddenCount: number;
  truncated: boolean;
  onOpen: (player: Player) => void;
  onClearFilters: () => void;
}) {
  // Pages of players, the same footer the family rows use (no "show all" link).
  const [page, setPage] = useState(1);
  const pages = Math.max(1, Math.ceil(players.length / SHOWN));
  const cur = Math.min(page, pages);
  const shown = players.slice((cur - 1) * SHOWN, cur * SHOWN);
  return (
    <div className="grid gap-1.5" role="region" aria-label="Players found">
      <div className="text-[11px] text-[var(--text-3)]">
        {[
          campaignRuns > 0 ? `${campaignRuns} ${campaignRuns === 1 ? "run" : "runs"}` : null,
          players.length > 0 ? `${players.length} ${players.length === 1 ? "player" : "players"}` : null,
        ].filter(Boolean).join(" · ") || `Nothing matches “${query}”.`}
        {hiddenCount > 0 && (
          <>
            {" · "}
            <button type="button" onClick={onClearFilters} className="text-primary hover:underline">
              {hiddenCount} more outside these filters
            </button>
          </>
        )}
        {truncated && <span className="text-amber-400"> · first 500 only</span>}
      </div>
      {shown.map((p) => (
        <button
          key={p.phone}
          type="button"
          onClick={() => onOpen(p)}
          className="group flex items-center gap-3 w-full text-left px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)]/50 hover:bg-[var(--bg-hover)] hover:border-[var(--border-2)] transition-colors"
        >
          <span className="min-w-0 flex items-baseline gap-2">
            <span className="text-[13px] font-medium text-[var(--text-1)] truncate">{p.name ?? "Unnamed player"}</span>
            <span className="font-mono text-[11.5px] text-[var(--text-3)] shrink-0">{p.phone}</span>
          </span>
          <span className="ml-auto flex items-center gap-3 shrink-0 text-[11px] font-mono text-[var(--text-3)]">
            <span>{p.runs.length} {p.runs.length === 1 ? "run" : "runs"}</span>
            <span>{p.attempts === 0 ? "never called" : `${p.attempts} ${p.attempts === 1 ? "attempt" : "attempts"}`}</span>
            {p.lastAttemptedAt && <span>last {shortDate(p.lastAttemptedAt)}</span>}
            {p.smsSent && <MessageSquare size={11} aria-label="SMS sent" />}
            <span className="px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-2)] font-sans">{p.latestOutcomeLabel}</span>
            <ChevronRight size={13} className="text-[var(--text-4)] group-hover:text-[var(--text-2)] transition-colors" />
          </span>
        </button>
      ))}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3 px-1 text-[11px] text-[var(--text-3)]">
          <span>Showing {(cur - 1) * SHOWN + 1}–{Math.min(cur * SHOWN, players.length)} of {players.length} players</span>
          <span className="inline-flex items-center gap-1 shrink-0">
            <button type="button" disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label="Previous players" className="w-6 h-6 rounded-md border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">‹</button>
            <span className="font-mono">{cur} / {pages}</span>
            <button type="button" disabled={cur >= pages} onClick={() => setPage(cur + 1)} aria-label="Next players" className="w-6 h-6 rounded-md border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">›</button>
          </span>
        </div>
      )}
    </div>
  );
}
