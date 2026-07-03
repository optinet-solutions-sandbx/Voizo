"use client";

// Segmented sort control — extracted from RankedTables (2026-07-02, Leaderboards consolidation)
// because CampaignTable keeps using it after the ranked tables merged into Leaderboards.

export type SortKey = "calls" | "connect" | "success" | "newest" | "reached" | "sms" | "positive";

const DEFAULT_KEYS: SortKey[] = ["calls", "connect", "reached", "sms", "positive"];
const DEFAULT_LABELS: Partial<Record<SortKey, string>> = { reached: "Reached", sms: "SMS", positive: "Positive" };

export function SortControl({
  sort,
  setSort,
  keys = DEFAULT_KEYS,
  labels,
}: {
  sort: SortKey;
  setSort: (s: SortKey) => void;
  keys?: SortKey[];
  labels?: Partial<Record<SortKey, string>>; // display override (e.g. calls → "Attempts")
}) {
  return (
    <div className="inline-flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-4)] font-semibold">Sort</span>
      <div className="inline-flex p-[3px] gap-0.5 rounded-[10px] bg-[var(--bg-elevated)] border border-[var(--border)]">
        {keys.map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setSort(k)}
            className={`px-2.5 py-1 rounded-[7px] text-xs font-semibold capitalize transition ${
              sort === k ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
            }`}
          >
            {labels?.[k] ?? DEFAULT_LABELS[k] ?? k}
          </button>
        ))}
      </div>
    </div>
  );
}
