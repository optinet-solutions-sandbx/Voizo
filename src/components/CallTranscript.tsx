// Shared call-transcript renderer — lifted from reviews/[campaignId]/page.tsx so the reviews
// cards and the dashboard per-contact detail modal use one copy. Colors AI vs User/Customer lines;
// scrolls within a fixed max height. Pure presentational (no hooks / browser APIs).
//
// `fill`: grow to fill a flex-column parent (flex-1) instead of the 260px cap — used by the
// QA Prompt Testing panel so the transcript stretches to the bottom of the viewport. Every
// other caller omits it and keeps the fixed-height card behaviour.

export default function CallTranscript({ text, fill = false }: { text: string; fill?: boolean }) {
  if (!text || !text.trim()) {
    return fill ? (
      <div className="flex-1 min-h-0 rounded-lg bg-[var(--bg-elevated)]/40 border border-[var(--border)] p-3 text-xs text-[var(--text-3)] italic">
        No transcript captured for this call.
      </div>
    ) : (
      <div className="text-xs text-[var(--text-3)] italic py-3">No transcript captured for this call.</div>
    );
  }
  // Single pass: trim + drop blanks together (no .map().filter() double-iteration).
  const lines = text.split(/\r?\n/).flatMap((l) => { const t = l.trim(); return t ? [t] : []; });
  return (
    <div className={`${fill ? "flex-1 min-h-0" : "max-h-[260px]"} overflow-y-auto rounded-lg bg-[var(--bg-elevated)]/40 border border-[var(--border)] p-3 flex flex-col gap-1.5`}>
      {lines.map((line, i) => {
        const isAI = /^(?:AI|Assistant|Bot)\b/i.test(line);
        const isUser = /^(?:User|Customer|Caller|Human)\b/i.test(line);
        return (
          <div key={i} className="text-xs leading-relaxed">
            <span className={isAI ? "text-blue-400 font-medium" : isUser ? "text-[var(--text-1)] font-medium" : "text-[var(--text-2)]"}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}
