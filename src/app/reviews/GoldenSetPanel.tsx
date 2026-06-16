// src/app/reviews/GoldenSetPanel.tsx
// "Is the AI grader trustworthy?" — the frozen-ruler panel on the Reviews page.
// Shows fixed test sets of hand-judged calls, how well the AI grader agrees with the
// human verdicts each time it's re-checked (drift over time), and a per-script
// success-rate readout. Operator-plain copy; the precise stat (Cohen's κ) is kept
// only as a hover tooltip. Data: GET /api/qa/golden · POST /api/qa/golden/freeze ·
// POST /api/qa/golden/[version]/replay · GET /api/qa/prompt-stats.
"use client";

import { useCallback, useEffect, useState } from "react";
import { Scale, RefreshCw, Snowflake, AlertCircle } from "lucide-react";
import { useMagnetic } from "@/components/useMagnetic";

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
  runs: { cohensKappa: number | null; n: number; createdAt: string }[];
}

export default function GoldenSetPanel() {
  const magnetRef = useMagnetic<HTMLElement>();
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
      setError(e instanceof Error ? e.message : "Failed to load test sets");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const doFreeze = useCallback(async () => {
    // Each save copies every labelled transcript into a NEW set (PII duplication),
    // so guard the accidental click (review M2).
    if (!window.confirm("Save the calls you've labelled good/bad into a new fixed test set?")) return;
    setBusy("freeze");
    setError(null);
    try {
      const note = `manual freeze ${new Date().toISOString().slice(0, 10)}`;
      const r = await fetch("/api/qa/golden/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ note }),
      });
      if (!r.ok) throw new Error(`Couldn't save the test set (HTTP ${r.status})`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't save the test set");
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
        if (!r.ok) throw new Error(j.error || `Re-check failed (HTTP ${r.status})`);
        await load();
        if (j.persisted === false) {
          setError("Score computed but couldn't be saved — re-check to store it.");
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : "Re-check failed");
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  return (
    <section ref={magnetRef} className="glow-card bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 grid gap-3">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Scale size={16} className="text-[var(--text-2)]" />
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Is the AI grader trustworthy?</h2>
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
            title="Snapshot the calls you've labelled good/bad into a fixed set the grader gets re-checked against."
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-1)] disabled:opacity-50 disabled:cursor-not-allowed transition"
          >
            <Snowflake size={12} /> {busy === "freeze" ? "Saving…" : "New test set"}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-[var(--text-3)]">
        A fixed set of calls you&apos;ve judged good or bad. Re-running the AI grader on that same set shows whether it
        still agrees with you — if its agreement slips over time, the grader has drifted.
      </p>

      {sets === null ? (
        <div className="text-xs text-[var(--text-3)] py-3">Loading…</div>
      ) : sets.length === 0 ? (
        <div className="text-xs text-[var(--text-3)] py-3">
          No test sets yet. Label some calls good/bad above, then click <strong>New test set</strong>.
        </div>
      ) : (
        <div className="divide-y divide-[var(--border)] border-t border-[var(--border)]">
          {sets.map((s) => (
            <div key={s.id} className="flex items-center gap-4 py-2.5 flex-wrap">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-[var(--text-1)] tabular-nums">Test set v{s.version}</span>
                  <span className="text-[11px] text-[var(--text-3)] font-mono">{s.itemCount} calls</span>
                  {s.note && <span className="text-[11px] text-[var(--text-3)] truncate">· {s.note}</span>}
                </div>
                {s.latestRun ? (
                  <div className="flex items-center gap-3 mt-1 text-[11px]">
                    <AgreementChip agreement={s.latestRun.agreement} kappa={s.latestRun.cohensKappa} />
                    <span className="text-[var(--text-3)] font-mono">
                      on {s.latestRun.n} call{s.latestRun.n === 1 ? "" : "s"}
                    </span>
                    <span className="text-[var(--text-3)] font-mono">checked {s.runCount}×</span>
                    <Sparkline runs={s.runs} />
                  </div>
                ) : (
                  <div className="mt-1 text-[11px] text-[var(--text-3)]">not checked yet</div>
                )}
              </div>
              <button
                type="button"
                onClick={() => doReplay(s.version)}
                disabled={busy !== null}
                title="Re-run the AI grader on this fixed set and log how well it agrees with your verdicts today."
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium border border-[var(--border)] text-[var(--text-2)] hover:border-[var(--border-2)] hover:text-[var(--text-1)] disabled:opacity-50 disabled:cursor-not-allowed transition"
              >
                <RefreshCw size={12} className={busy === `replay:${s.version}` ? "animate-spin" : ""} />
                {busy === `replay:${s.version}` ? "Re-checking…" : "Re-check grader"}
              </button>
            </div>
          ))}
        </div>
      )}
      <PromptVersionStats />
    </section>
  );
}

// Plain "agrees with you X%" lead (colored by agreement), with the precise stat
// (Cohen's κ) kept only as a hover tooltip so operators aren't shown jargon.
function AgreementChip({ agreement, kappa }: { agreement: number | null; kappa: number | null }) {
  if (agreement == null) return <span className="text-[var(--text-3)] font-mono">no reading yet</span>;
  const aPct = Math.round(agreement * 100);
  const tone = aPct >= 90 ? "text-emerald-400" : aPct >= 70 ? "text-amber-400" : "text-red-400";
  const title =
    kappa != null ? `Cohen's κ ${kappa.toFixed(2)} — agreement corrected for chance (1.0 = perfect)` : "agreement with your verdicts";
  return (
    <span className={`font-semibold ${tone}`} title={title}>
      agrees with you {aPct}%
    </span>
  );
}

// Agreement-over-time trend across this set's re-checks (oldest→newest). A 2+-point
// SVG line, no chart lib — colored by the latest κ band. Hidden until 2 points.
function Sparkline({ runs }: { runs: { cohensKappa: number | null }[] }) {
  const pts = runs.filter((r) => r.cohensKappa != null).map((r) => r.cohensKappa as number);
  if (pts.length < 2) return null;
  const W = 80;
  const H = 18;
  const ys = (k: number) => H - Math.max(0, Math.min(1, k)) * H; // κ 0..1 → bottom..top
  const d = pts
    .map((k, i) => `${i === 0 ? "M" : "L"}${((i / (pts.length - 1)) * W).toFixed(1)},${ys(k).toFixed(1)}`)
    .join(" ");
  const last = pts[pts.length - 1];
  const stroke = last >= 0.6 ? "#34d399" : last >= 0.4 ? "#fbbf24" : "#f87171";
  return (
    <svg width={W} height={H} role="img" aria-label="agreement over time">
      <title>Agreement over time</title>
      <path d={d} fill="none" stroke={stroke} strokeWidth="1.5" />
    </svg>
  );
}

interface PromptStat {
  promptVersionId: string;
  n: number;
  successRate: number | null;
  createdAt: string | null;
}

// "How each bot-script version scored" — the grader's success-rate per script version
// from production calls (GET /api/qa/prompt-stats). Shows the script's date (readable)
// rather than its internal id. Empty until the grader runs in production.
function PromptVersionStats() {
  const [stats, setStats] = useState<PromptStat[] | null>(null);
  const [judgeEnabled, setJudgeEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/qa/prompt-stats", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { judgeEnabled: boolean; stats: PromptStat[] };
        setStats(j.stats);
        setJudgeEnabled(j.judgeEnabled);
        setErr(null);
      } catch (e) {
        setErr(e instanceof Error ? e.message : "failed");
      }
    })();
  }, []);
  return (
    <div className="border-t border-[var(--border)] pt-3 mt-1 grid gap-2">
      <h3 className="text-[11px] font-semibold text-[var(--text-2)] uppercase tracking-wider">
        How each bot-script version scored
      </h3>
      <p className="text-[11px] text-[var(--text-3)] -mt-1">
        The grader&apos;s success rate for calls run under each version of the bot&apos;s script (newer scripts have
        later dates). Most meaningful within one campaign.
      </p>
      {err ? (
        <p className="text-[11px] text-amber-400 font-mono">{err}</p>
      ) : stats === null ? (
        <p className="text-[11px] text-[var(--text-3)]">Loading…</p>
      ) : !judgeEnabled ? (
        <p className="text-[11px] text-[var(--text-3)]">Grader is off — no scored calls to compare yet.</p>
      ) : stats.length === 0 ? (
        <p className="text-[11px] text-[var(--text-3)]">No scored calls yet.</p>
      ) : (
        <div className="divide-y divide-[var(--border)]">
          {stats.map((s) => (
            <div key={s.promptVersionId} className="flex items-center gap-3 py-1.5 text-[11px]">
              <span
                className="flex-1 truncate text-[var(--text-3)] font-mono"
                title={`script version id ${s.promptVersionId}`}
              >
                {s.createdAt ? `script · ${s.createdAt.slice(0, 10)}` : `script · ${s.promptVersionId.slice(0, 8)}`}
              </span>
              <span className="text-[var(--text-3)] font-mono">
                {s.n} call{s.n === 1 ? "" : "s"}
              </span>
              <span className="text-[var(--text-1)] font-semibold tabular-nums w-12 text-right">
                {s.successRate != null ? `${Math.round(s.successRate * 100)}%` : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
