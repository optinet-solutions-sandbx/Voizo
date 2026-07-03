// Shared call-transcript renderer — lifted from reviews/[campaignId]/page.tsx so the reviews
// cards and the dashboard per-contact detail modal use one copy. Colors AI vs User/Customer lines;
// scrolls within a fixed max height. Pure presentational (no hooks / browser APIs).

export default function CallTranscript({ text }: { text: string }) {
  if (!text || !text.trim()) {
    return <div className="text-xs text-[var(--text-3)] italic py-3">No transcript captured for this call.</div>;
  }
  // Single pass: trim + drop blanks together (no .map().filter() double-iteration).
  const lines = text.split(/\r?\n/).flatMap((l) => { const t = l.trim(); return t ? [t] : []; });
  return (
    <div className="max-h-[260px] overflow-y-auto rounded-lg bg-[var(--bg-elevated)]/40 border border-[var(--border)] p-3 flex flex-col gap-1.5">
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
