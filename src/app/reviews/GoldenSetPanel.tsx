// src/app/reviews/GoldenSetPanel.tsx
// The frozen-ruler panel on the Reviews landing page. Lists golden-eval-set versions
// with their latest replay (kappa/agreement on the FIXED ruler), and lets an operator
// freeze a new version from the current clean labels or re-run the judge against a set.
// Data: GET /api/qa/golden · POST /api/qa/golden/freeze · POST /api/qa/golden/[version]/replay.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Scale, RefreshCw, Snowflake, AlertCircle } from "lucide-react";

interface LatestRun {
  judgeVersion: string;
  judgeModel: string;
  n: number;
  agreement: number | null;
  cohensKappa: number | null;
  createdAt: string;
}
interface GoldenSet {
  id: string;
  version: number;
  note: string | null;
  itemCount: number;
  createdAt: string;
  latestRun: LatestRun | null;
  runCount: number;
}

export default function GoldenSetPanel() {
  const [sets, setSets] = useState<GoldenSet[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null); // "freeze" | `replay:${version}`

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/qa/golden", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = (await r.json()) as { sets: GoldenSet[] };
      setSets(j.sets);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load golden sets");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doFreeze = useCallback(async () => {
    // Each freeze copies every clean labeled transcript into a NEW version (PII duplication),
    // so guard the accidental click (review M2).
    if (!window.confirm("Freeze a new golden-set version from the current clean (good/bad) labels?")) return;
    setBusy("freeze");
    setError(null);
    try {
      const note = `manual freeze ${new Date().toISOString().slice(0, 10)}`;
      const r = await fetch("/api/qa/golden/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!r.ok) throw new Error(`Freeze failed (HTTP ${r.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Freeze failed");
    } finally {
      setBusy(null);
    }
  }, [load]);

  const doReplay = useCallback(
    async (version: number) => {
      setBusy(`replay:${version}`);
      setError(null);
      try {
        const r = await fetch(`/api/qa/golden/${version}/replay`, { method: "POST" });
        const j = (await r.json().catch(() => ({}))) as { error?: string; persisted?: boolean };
        if (!r.ok) throw new Error(j.error || `Replay failed (HTTP ${r.status})`);
        await load();
        if (j.persisted === false) {
          setError("κ computed but the drift-log row failed to save — replay again to persist it.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Replay failed");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Scale size={16} className="text-[var(--text-2)]" />
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Golden eval set — the frozen ruler</h2>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
          <button
            type="button"
            onClick={doFreeze}
            disabled={busy !== null}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-1)] disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <Snowflake size={12} /> {busy === "freeze" ? "Freezing…" : "Freeze new version"}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--text-3)]">
        A frozen snapshot of clean good/bad labels. Re-running the judge against the same set gives a κ that&apos;s
        comparable over time — drift, not a moving target.
      </p>

      {sets === null ? (
        <div className="text-xs text-[var(--text-3)] py-3">Loading…</div>
      ) : sets.length === 0 ? (
        <div className="text-xs text-[var(--text-3)] py-3">
          No frozen sets yet. Label clean conversations good/bad, then <strong>Freeze</strong> the first version.
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {sets.map((s) => (
            <div key={s.id} className="flex items-center gap-4 py-2.5 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-1)] tabular-nums">v{s.version}</span>
                  <span className="text-[11px] text-[var(--text-3)] font-mono">{s.itemCount} items</span>
                  {s.note && <span className="text-[11px] text-[var(--text-3)] truncate">· {s.note}</span>}
                </div>
                {s.latestRun ? (
                  <div className="flex items-center gap-3 mt-1 text-[11px] font-mono">
                    <KappaChip kappa={s.latestRun.cohensKappa} />
                    <span className="text-[var(--text-3)]">
                      agree {s.latestRun.agreement != null ? `${Math.round(s.latestRun.agreement * 100)}%` : "—"}
                    </span>
                    <span className="text-[var(--text-3)]">n={s.latestRun.n}</span>
                    <span className="text-[var(--text-3)]">{s.runCount} run{s.runCount === 1 ? "" : "s"}</span>
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-[var(--text-3)]">not replayed yet</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => doReplay(s.version)}
                disabled={busy !== null}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-1)] disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <RefreshCw size={12} className={busy === `replay:${s.version}` ? "animate-spin" : ""} />
                {busy === `replay:${s.version}` ? "Replaying…" : "Replay judge"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function KappaChip({ kappa }: { kappa: number | null }) {
  if (kappa == null) return <span className="text-[var(--text-3)]">κ —</span>;
  // Landis-Koch shorthand: >=0.6 substantial (emerald), >=0.4 moderate (amber), else weak (red).
  const tone = kappa >= 0.6 ? "text-emerald-400" : kappa >= 0.4 ? "text-amber-400" : "text-red-400";
  return <span className={`font-semibold ${tone}`}>κ {kappa.toFixed(2)}</span>;
}
