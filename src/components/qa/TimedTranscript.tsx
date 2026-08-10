"use client";

// TimedTranscript — the QA transcript with per-turn timestamps + agent response
// latency, from Vapi's message timing (fetched on demand). Clicking a timestamp
// seeks the recording. A summary bar up top answers "how long did the agent take
// to respond" at a glance. Falls back to the plain CallTranscript when timing is
// unavailable (handled by the parent).

export interface TimelineTurn {
  role: "agent" | "customer";
  atSec: number;
  text: string;
  gapSec: number | null;
  isResponse: boolean;
}

function mmss(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export default function TimedTranscript({
  turns,
  durationSec,
  onSeek,
}: {
  turns: TimelineTurn[];
  durationSec: number | null;
  onSeek?: (sec: number) => void;
}) {
  const responses = turns.filter((t) => t.isResponse && t.gapSec != null) as (TimelineTurn & { gapSec: number })[];
  const avgResponse = responses.length ? responses.reduce((s, t) => s + t.gapSec, 0) / responses.length : null;
  const slowest = responses.length ? Math.max(...responses.map((t) => t.gapSec)) : null;

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      {/* summary */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono text-[var(--text-3)] shrink-0">
        {durationSec != null && <span>Call {mmss(durationSec)}</span>}
        <span>· {turns.length} turns</span>
        {avgResponse != null && (
          <span>
            · agent responds in <span className="text-[var(--text-1)]">{avgResponse.toFixed(1)}s</span> avg
          </span>
        )}
        {slowest != null && <span>· slowest {slowest.toFixed(1)}s</span>}
        <span className="text-[var(--text-4)]">· click a time to jump in the recording</span>
      </div>

      {/* turns */}
      <div className="flex-1 min-h-0 overflow-y-auto rounded-lg bg-[var(--bg-elevated)]/40 border border-[var(--border)] p-3 flex flex-col gap-2">
        {turns.map((t, i) => {
          const isAgent = t.role === "agent";
          return (
            <div key={i} className="text-xs leading-relaxed flex gap-2">
              <button
                onClick={() => onSeek?.(t.atSec)}
                title="Jump to this moment in the recording"
                className="shrink-0 w-[38px] text-right font-mono text-[10px] tabular-nums pt-0.5 text-[var(--text-3)] hover:text-primary transition"
              >
                {mmss(t.atSec)}
              </button>
              <div className="min-w-0 flex-1">
                <span className={isAgent ? "text-blue-400 font-medium" : "text-[var(--text-1)] font-medium"}>
                  Message {i + 1} · {isAgent ? "Agent" : "Customer"}:{" "}
                </span>
                <span className={isAgent ? "text-[var(--text-2)]" : "text-[var(--text-1)]"}>{t.text}</span>
                {t.isResponse && t.gapSec != null && t.gapSec >= 0.1 && (
                  <span className="ml-1.5 text-[10px] font-mono text-amber-400/80 whitespace-nowrap">
                    responded in {t.gapSec.toFixed(1)}s
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
