"use client";

// QaRecordsDrawer — slide-over that lists the analysis runs behind a clicked
// dashboard number (a "slice": campaign and/or call_attempt / reached_category,
// within the current date window). Mirrors the campaigns dashboard's click-a-total
// → records-drawer pattern. Each row opens the stored run (returns to the QA tool).

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";

export interface DrawerSlice {
  title: string;
  campaignId?: string;
  callAttempt?: string;
  reachedCategory?: string;
}

interface RunItem {
  id: string;
  campaignName: string | null;
  customerName: string | null;
  customerPhone: string | null;
  callCreatedAt: string | null;
  summary: string | null;
}

const fmt = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};

function digest(summary: string | null): { chip: string | null; text: string } {
  if (!summary) return { chip: null, text: "—" };
  const cleaned = summary.replace(/^```[a-z]*\n?/i, "").replace(/\n?```$/, "").trim();
  try {
    const o = JSON.parse(cleaned) as Record<string, unknown>;
    const chip =
      (typeof o.reached_category === "string" && o.reached_category) ||
      (typeof o.call_attempt === "string" && o.call_attempt) ||
      null;
    const text = (typeof o.summary === "string" && o.summary) || cleaned.slice(0, 160);
    return { chip, text };
  } catch {
    return { chip: null, text: cleaned.replace(/\s+/g, " ").slice(0, 160) };
  }
}

export default function QaRecordsDrawer({
  slice,
  day,
  fromMs,
  toMs,
  promptId,
  onClose,
}: {
  slice: DrawerSlice;
  day: string | null;
  fromMs: number | null;
  toMs: number | null;
  promptId?: string | null;
  onClose: () => void;
}) {
  const [runs, setRuns] = useState<RunItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setRuns(null);
    setError(null);
    try {
      const p = new URLSearchParams({ limit: "500", latestPerCall: "1" });
      if (day) p.set("day", day);
      else {
        if (fromMs != null) p.set("fromMs", String(fromMs));
        if (toMs != null) p.set("toMs", String(toMs));
      }
      if (slice.campaignId) p.set("campaignId", slice.campaignId);
      if (slice.callAttempt) p.set("callAttempt", slice.callAttempt);
      if (slice.reachedCategory) p.set("reachedCategory", slice.reachedCategory);
      if (promptId) p.set("promptId", promptId);
      const r = await fetch(`/api/qa-prompt-testing/runs?${p.toString()}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setRuns(((await r.json()) as { runs: RunItem[] }).runs);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load records");
    }
  }, [slice, day, fromMs, toMs, promptId]);

  useEffect(() => {
    load();
  }, [load]);

  // Escape to close.
  useEffect(() => {
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", h);
    return () => document.removeEventListener("keydown", h);
  }, [onClose]);

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} aria-hidden />
      <aside className="fixed right-0 top-0 bottom-0 z-50 w-full max-w-md bg-[var(--bg-app)] border-l border-[var(--border)] flex flex-col shadow-2xl">
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--border)] flex-shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-[var(--text-1)] truncate">{slice.title}</h3>
            <p className="text-[11px] text-[var(--text-3)]">{runs ? `${runs.length} call${runs.length === 1 ? "" : "s"}` : "Loading…"}</p>
          </div>
          <button onClick={onClose} className="ml-auto p-1.5 rounded-lg text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {error ? (
            <p className="p-4 text-xs text-red-400">{error}</p>
          ) : !runs ? (
            <div className="p-4 grid gap-2">
              {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-14 rounded-lg bg-[var(--bg-elevated)] animate-pulse" />)}
            </div>
          ) : runs.length === 0 ? (
            <p className="p-6 text-center text-sm text-[var(--text-3)]">No calls in this slice.</p>
          ) : (
            <div className="divide-y divide-[var(--border)]">
              {runs.map((r) => {
                const d = digest(r.summary);
                return (
                  <Link
                    key={r.id}
                    href={`/qa-prompt-testing/history/${r.id}?from=${encodeURIComponent("/qa-prompt-testing")}`}
                    className="block px-4 py-3 hover:bg-[var(--bg-hover)] transition"
                  >
                    <div className="flex items-center gap-2 min-w-0 flex-wrap">
                      <span className="text-xs font-medium text-[var(--text-1)] truncate max-w-[180px]">
                        {r.customerName || r.customerPhone || "Call"}
                      </span>
                      {d.chip && (
                        <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full bg-[var(--bg-elevated)] text-[var(--text-2)] border border-[var(--border)]">
                          {d.chip}
                        </span>
                      )}
                      <span className="text-[10px] text-[var(--text-3)] font-mono ml-auto">{fmt(r.callCreatedAt)}</span>
                    </div>
                    <p className="text-[11px] text-[var(--text-2)] mt-1 line-clamp-2 break-words">{d.text}</p>
                    {r.campaignName && <p className="text-[10px] text-[var(--text-3)] truncate mt-0.5">{r.campaignName}</p>}
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </aside>
    </>
  );
}
