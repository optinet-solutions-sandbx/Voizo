// src/app/reviews/AgentPerformancePanel.tsx
// "How are our agents doing — and why do calls fall through?" — read-only view over the
// AI judge's verdicts on Reviews: (1) how calls are landing, (2) the top reasons calls
// don't convert (themes clustered from the judge's notes), (3) how each base agent
// compares. Operator-plain copy. Data: GET /api/qa/agent-performance.
"use client";

import { useEffect, useState } from "react";
import { Gauge, AlertCircle } from "lucide-react";

interface FailureThemeCount {
  theme: string;
  label: string;
  count: number;
  pct: number;
  examples: string[];
}
interface VerdictMix {
  success: number;
  failure: number;
  unsure: number;
  unscored: number;
  total: number;
  successPct: number | null;
  failurePct: number | null;
  unsurePct: number | null;
}
interface AgentRollup {
  baseAssistantId: string;
  shortId: string;
  campaignNames: string[];
  scored: number;
  success: number;
  failure: number;
  unsure: number;
  successPct: number | null;
  failurePct: number | null;
  unsurePct: number | null;
  avgAccuracy: number | null;
  avgClarity: number | null;
  avgNaturalFlow: number | null;
}
interface ApResult {
  verdictMix: VerdictMix;
  failureThemes: FailureThemeCount[];
  agents: AgentRollup[];
  meta: { totalScores: number; nonTestScores: number; excludedTestScores: number; resolvedToBase: number; judgeModel: string | null };
}

const pct = (v: number | null) => (v == null ? "—" : `${Math.round(v * 100)}%`);

export default function AgentPerformancePanel() {
  const [data, setData] = useState<ApResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [openTheme, setOpenTheme] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/qa/agent-performance", { cache: "no-store" });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        setData((await r.json()) as ApResult);
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load this panel");
      }
    })();
  }, []);

  const vm = data?.verdictMix;
  const failures = data?.failureThemes ?? [];
  const maxTheme = failures.reduce((m, t) => Math.max(m, t.count), 0);

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 grid gap-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Gauge size={16} className="text-[var(--text-2)]" />
          <h2 className="text-sm font-semibold text-[var(--text-1)]">How are our agents doing — and why do calls fall through?</h2>
        </div>
        {error && (
          <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
            <AlertCircle size={11} /> {error}
          </span>
        )}
      </div>

      {data === null ? (
        <div className="text-xs text-[var(--text-3)] py-3">Loading…</div>
      ) : !vm || vm.total === 0 ? (
        <div className="text-xs text-[var(--text-3)] py-3">No scored calls yet.</div>
      ) : (
        <>
          {/* 1. Verdict mix */}
          <div className="grid gap-1.5">
            <p className="text-[11px] text-[var(--text-3)]">
              How calls are landing, as judged by the AI grader ({vm.total} real calls
              {vm.unscored > 0 ? `, ${vm.unscored} not yet scored` : ""}
              {data.meta.excludedTestScores > 0 ? `, ${data.meta.excludedTestScores} test excluded` : ""}).
            </p>
            <div className="flex items-center gap-3 text-[11px] font-mono flex-wrap">
              <span className="text-emerald-400">won: {pct(vm.successPct)} ({vm.success})</span>
              <span className="text-red-400">lost: {pct(vm.failurePct)} ({vm.failure})</span>
              <span
                className="text-amber-400"
                title="The grader couldn't confidently call it a win or a loss — often a very short or ambiguous call."
              >
                grader unsure: {pct(vm.unsurePct)} ({vm.unsure})
              </span>
            </div>
            {vm.unsurePct != null && vm.unsurePct >= 0.4 && (
              <p className="text-[11px] text-amber-400/90">
                ⚠ The grader is unsure on ~{pct(vm.unsurePct)} of calls — worth a look at whether those are genuinely
                ambiguous or short/no-answer calls slipping through.
              </p>
            )}
          </div>

          {/* 2. Top failure themes */}
          {failures.length > 0 && (
            <div className="grid gap-1.5 border-t border-[var(--border)] pt-3">
              <p className="text-[11px] uppercase tracking-wider text-[var(--text-3)]">Top reasons calls don&apos;t convert</p>
              <div className="grid gap-1.5">
                {failures.map((t) => (
                  <div key={t.theme} className="grid gap-1">
                    <button
                      type="button"
                      onClick={() => setOpenTheme(openTheme === t.theme ? null : t.theme)}
                      className="flex items-center gap-3 text-left group"
                    >
                      <span className="text-[11px] text-[var(--text-2)] w-64 flex-shrink-0 truncate">
                        {t.label}
                        {t.theme === "agent_no_consent" && <span className="text-blue-300"> ← fixable</span>}
                      </span>
                      <span className="flex-1 h-2 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
                        <span
                          className="block h-full bg-red-500/70"
                          style={{ width: `${maxTheme > 0 ? Math.round((t.count / maxTheme) * 100) : 0}%` }}
                        />
                      </span>
                      <span className="text-[11px] font-mono text-[var(--text-3)] w-16 text-right">
                        {pct(t.pct)} ({t.count})
                      </span>
                    </button>
                    {openTheme === t.theme && t.examples.length > 0 && (
                      <ul className="ml-2 pl-3 border-l border-[var(--border)] grid gap-1">
                        {t.examples.map((ex) => (
                          <li key={ex} className="text-[11px] text-[var(--text-3)] italic">
                            &ldquo;{ex}&rdquo;
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-[var(--text-3)]">Click a row to see example call notes. Themes are grouped from the grader&apos;s written reasons.</p>
            </div>
          )}

          {/* 3. Per-base-agent rollup */}
          {data.agents.length > 0 && (
            <div className="grid gap-1 border-t border-[var(--border)] pt-3">
              <p className="text-[11px] uppercase tracking-wider text-[var(--text-3)]">How does each agent compare?</p>
              <div className="flex items-center gap-3 pt-1 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-3)]">
                <span className="flex-1">agent</span>
                <span className="w-12 text-right">calls</span>
                <span className="w-12 text-right text-emerald-400">won</span>
                <span className="w-12 text-right text-red-400">lost</span>
                <span className="w-14 text-right text-amber-400" title="The grader couldn't confidently call it">unsure</span>
                <span className="w-16 text-right" title="Average of the grader's accuracy / clarity / natural-flow scores (1–5)">quality</span>
              </div>
              <div className="divide-y divide-[var(--border)]">
                {data.agents.map((a) => {
                  const q = [a.avgAccuracy, a.avgClarity, a.avgNaturalFlow].filter((x): x is number => x != null);
                  const qAvg = q.length ? (q.reduce((s, x) => s + x, 0) / q.length).toFixed(1) : "—";
                  return (
                    <div key={a.baseAssistantId} className="flex items-center gap-3 py-2 text-[11px]">
                      <span className="flex-1 min-w-0 truncate text-[var(--text-2)]" title={a.baseAssistantId}>
                        {a.baseAssistantId === "unattributed" ? (
                          <span className="text-[var(--text-3)] italic">
                            Unattributed · no base agent
                            {a.campaignNames.length > 0 ? ` (${a.campaignNames.length} campaign${a.campaignNames.length === 1 ? "" : "s"})` : ""}
                          </span>
                        ) : (
                          <>
                            {a.campaignNames[0] ?? a.shortId}
                            {a.campaignNames.length > 1 && <span className="text-[var(--text-3)]"> +{a.campaignNames.length - 1}</span>}
                          </>
                        )}
                      </span>
                      <span className="w-12 text-right font-mono text-[var(--text-3)]">{a.scored}</span>
                      <span className="w-12 text-right font-mono text-emerald-400">{pct(a.successPct)}</span>
                      <span className="w-12 text-right font-mono text-red-400">{pct(a.failurePct)}</span>
                      <span className="w-14 text-right font-mono text-amber-400">{pct(a.unsurePct)}</span>
                      <span className="w-16 text-right font-mono text-[var(--text-2)]">{qAvg}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
