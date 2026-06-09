"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Ghost, Loader2, Plus, RefreshCw } from "lucide-react";
import type { GhostRunRow } from "@/lib/ghost/ghostRunData";
import { parseJsonBody } from "@/lib/jsonBody";
import { StatusBadge, TierBadge } from "./badges";
import CreateRunDrawer from "./CreateRunDrawer";

// Operator Control Room — list of GhostPortal runs. Models on the campaigns
// table shell (dark design system, CSS-var tokens). Read via GET /api/ghost/runs
// (service-role behind Basic Auth). Ghost runs are intentionally absent from the
// client /campaigns list (Task 8), so this is the only window into them.

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", hour12: true });
}

export default function GhostRunsClient() {
  const [runs, setRuns] = useState<GhostRunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch("/api/ghost/runs", { headers: { "Content-Type": "application/json" } });
      if (!r.ok) {
        const body = (await parseJsonBody(r)) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { runs: GhostRunRow[] };
      setRuns(body.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load runs");
      setRuns([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="min-h-screen bg-[var(--bg-app)] text-[var(--text-1)]">
      <div className="max-w-6xl mx-auto px-5 py-8">
        {/* Header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div className="min-w-0">
            <h1 className="text-xl font-bold tracking-tight inline-flex items-center gap-2">
              <Ghost size={20} className="text-violet-400" /> GhostPortal
            </h1>
            <p className="text-sm text-[var(--text-3)] mt-1">
              Internal control room — launch voice-AI runs from a manual list. DNC + consent enforced; segregated from client data.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void load()}
              title="Refresh"
              className="p-2 rounded-xl border border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-3)] hover:text-[var(--text-1)] transition"
            >
              <RefreshCw size={15} />
            </button>
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-white text-sm font-medium transition"
            >
              <Plus size={15} /> New run
            </button>
          </div>
        </div>

        {error && (
          <div className="mb-4 px-4 py-3 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-xs text-red-300 inline-flex items-center gap-2">
            <AlertTriangle size={13} className="text-red-400" /> {error}
          </div>
        )}

        {/* Table */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
          {runs === null ? (
            <div className="p-10 flex items-center justify-center text-[var(--text-3)] text-sm gap-2">
              <Loader2 size={15} className="animate-spin" /> Loading runs…
            </div>
          ) : runs.length === 0 ? (
            <div className="p-12 text-center">
              <Ghost size={28} className="mx-auto text-[var(--text-3)] mb-3" />
              <p className="text-sm text-[var(--text-2)] font-medium">No runs yet</p>
              <p className="text-xs text-[var(--text-3)] mt-1">Click “New run” to upload a list and launch.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-[var(--text-3)] border-b border-[var(--border)]">
                  <th className="px-4 py-3 font-semibold">Run</th>
                  <th className="px-4 py-3 font-semibold">Tier</th>
                  <th className="px-4 py-3 font-semibold">Status</th>
                  <th className="px-4 py-3 font-semibold text-right">Uploaded</th>
                  <th className="px-4 py-3 font-semibold text-right">Net</th>
                  <th className="px-4 py-3 font-semibold text-right">Suppressed</th>
                  <th className="px-4 py-3 font-semibold">Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id} className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--bg-app)]/50 transition">
                    <td className="px-4 py-3">
                      <Link href={`/s/${run.slug}`} className="font-medium text-[var(--text-1)] hover:text-violet-300 transition">
                        {run.name}
                      </Link>
                      <div className="text-[10px] text-[var(--text-3)] font-mono mt-0.5">{run.slug}</div>
                    </td>
                    <td className="px-4 py-3"><TierBadge tier={run.tier} /></td>
                    <td className="px-4 py-3">
                      <StatusBadge status={run.status} />
                      {run.status === "failed" && run.fail_reason && (
                        <div className="text-[10px] text-red-400 mt-0.5 max-w-[220px] truncate" title={run.fail_reason}>
                          {run.fail_reason}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right tabular-nums text-[var(--text-2)]">{run.uploaded_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-emerald-300">{run.scrubbed_count}</td>
                    <td className="px-4 py-3 text-right tabular-nums text-amber-300">{run.suppressed_count}</td>
                    <td className="px-4 py-3 text-[var(--text-3)] text-xs">{fmtWhen(run.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <CreateRunDrawer
        key={drawerOpen ? "open" : "closed"}
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        onDone={() => {
          setDrawerOpen(false);
          void load();
        }}
      />
    </div>
  );
}
