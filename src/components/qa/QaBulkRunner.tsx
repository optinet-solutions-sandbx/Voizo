"use client";

// QaBulkRunner — ALL-CAMPAIGNS bulk analysis + daily schedule.
//
//   • Manual: pick a prompt + a period (Today / Yesterday / Last 7 days / 1 month / All),
//     then "Analyze all campaigns" submits one OpenAI batch per campaign for every reached,
//     not-yet-analyzed call in that window. "Import completed now" pulls finished batches in.
//   • Scheduled: a toggle that runs the same analysis automatically each day (yesterday's
//     calls across all campaigns). OFF by default — enabling starts standing daily spend.
//
// The live batch/results list below reuses AnalysisHistory (all campaigns). Isolated from the
// campaigns dashboard — only ever touches the listener_qa_* tables via the QA API.

import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, CalendarClock, Loader2, Play, RefreshCw, Rocket } from "lucide-react";
import AnalysisHistory from "./AnalysisHistory";

interface QaPrompt {
  id: string;
  title: string;
  isActive: boolean;
}
interface Schedule {
  enabled: boolean;
  promptId: string | null;
  lastRunAt: string | null;
  lastRunSummary: string | null;
}

type Period = "today" | "yesterday" | "7d" | "30d" | "all";
const PERIODS: { key: Period; label: string }[] = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "1 month" },
  { key: "all", label: "All" },
];

// Browser-local day boundaries by call date — matches the QA dashboard's windows.
function windowFor(p: Period): { fromMs: number | null; toMs: number | null } {
  const now = Date.now();
  const d = new Date();
  const midnight = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  switch (p) {
    case "today": return { fromMs: midnight, toMs: null };
    case "yesterday": return { fromMs: midnight - 86_400_000, toMs: midnight };
    case "7d": return { fromMs: now - 7 * 86_400_000, toMs: null };
    case "30d": return { fromMs: now - 30 * 86_400_000, toMs: null };
    default: return { fromMs: null, toMs: null };
  }
}

const fmt = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};

export default function QaBulkRunner() {
  const [prompts, setPrompts] = useState<QaPrompt[]>([]);
  const [promptId, setPromptId] = useState<string>("");
  const [period, setPeriod] = useState<Period>("7d");
  const [running, setRunning] = useState(false);
  const [importing, setImporting] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const [schedule, setSchedule] = useState<Schedule | null>(null);
  const [savingSchedule, setSavingSchedule] = useState(false);

  // Load prompts + schedule once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/qa-prompt-testing/prompts", { cache: "no-store" });
        const list = ((await r.json()) as { prompts: QaPrompt[] }).prompts ?? [];
        setPrompts(list);
        const preferred = list.find((p) => p.isActive) ?? list[0];
        if (preferred) setPromptId((cur) => cur || preferred.id);
      } catch {
        /* picker just stays empty */
      }
      try {
        const r = await fetch("/api/qa-prompt-testing/schedule", { cache: "no-store" });
        if (r.ok) setSchedule((await r.json()) as Schedule);
      } catch {
        /* schedule section shows disabled */
      }
    })();
  }, []);

  const runAll = useCallback(async () => {
    if (!promptId) { setMsg({ kind: "err", text: "Choose a prompt first." }); return; }
    setRunning(true);
    setMsg(null);
    const { fromMs, toMs } = windowFor(period);
    try {
      const r = await fetch("/api/qa-prompt-testing/batch/all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ promptId, fromMs, toMs }),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if ((data.submittedBatches ?? 0) === 0 && !data.deferredCampaigns) {
        setMsg({ kind: "ok", text: data.message || "Nothing to analyze in this window — all caught up." });
      } else {
        setMsg({
          kind: "ok",
          text: `Submitted ${data.submittedBatches} batch(es) · ${data.submittedCalls?.toLocaleString?.() ?? data.submittedCalls} calls.${data.note ? ` ${data.note}` : ""} They run in the background — import when complete.`,
        });
      }
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to submit." });
    } finally {
      setRunning(false);
    }
  }, [promptId, period]);

  const importNow = useCallback(async () => {
    setImporting(true);
    setMsg(null);
    try {
      const r = await fetch("/api/qa-prompt-testing/batch/import", { method: "POST" });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setMsg({
        kind: "ok",
        text: `Imported ${data.imported?.toLocaleString?.() ?? data.imported} result(s). ${data.active ? `${data.active} batch(es) still running.` : "No batches still running."}`,
      });
      setRefreshKey((k) => k + 1);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Import failed." });
    } finally {
      setImporting(false);
    }
  }, []);

  const saveSchedule = useCallback(async (patch: { enabled?: boolean; promptId?: string }) => {
    setSavingSchedule(true);
    try {
      const r = await fetch("/api/qa-prompt-testing/schedule", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      const data = await r.json();
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      setSchedule(data as Schedule);
      setMsg(null);
    } catch (e) {
      setMsg({ kind: "err", text: e instanceof Error ? e.message : "Failed to save schedule." });
    } finally {
      setSavingSchedule(false);
    }
  }, []);

  const busy = running || importing;
  const promptOptions = useMemo(() => prompts, [prompts]);

  return (
    <div className="grid gap-5">
      {/* ── Manual run ── */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 grid gap-4">
        <div className="flex items-center gap-2">
          <Rocket size={15} className="text-primary" />
          <h2 className="text-sm font-semibold text-[var(--text-1)]">Analyze all campaigns</h2>
        </div>
        <p className="text-xs text-[var(--text-3)] -mt-2 max-w-2xl">
          Submits one background batch per campaign for every reached call (with a transcript) in the chosen window that
          hasn&apos;t already been analyzed with this prompt. Safe to re-run — already-analyzed calls are skipped.
        </p>

        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid gap-1.5">
            <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Prompt</span>
            <select
              value={promptId}
              onChange={(e) => setPromptId(e.target.value)}
              className="text-xs bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-1)] focus:outline-none focus:border-primary/50"
            >
              {promptOptions.length === 0 && <option value="">No prompts in library</option>}
              {promptOptions.map((p) => (
                <option key={p.id} value={p.id}>{p.title}{p.isActive ? " (default)" : ""}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="grid gap-1.5">
          <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--text-3)]">Period</span>
          <div className="inline-flex flex-wrap gap-1 p-1 rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] w-fit">
            {PERIODS.map((p) => (
              <button
                key={p.key}
                onClick={() => setPeriod(p.key)}
                className={`px-3 py-1 rounded-md text-xs font-medium transition whitespace-nowrap ${
                  period === p.key ? "bg-primary text-white" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            onClick={runAll}
            disabled={busy || !promptId}
            className="inline-flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {running ? <Loader2 size={14} className="animate-spin" /> : <Play size={14} />}
            {running ? "Submitting…" : "Analyze all campaigns"}
          </button>
          <button
            onClick={importNow}
            disabled={busy}
            className="inline-flex items-center gap-2 rounded-lg border border-[var(--border)] px-4 py-2 text-xs font-medium text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] disabled:opacity-50"
          >
            {importing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {importing ? "Importing…" : "Import completed now"}
          </button>
        </div>

        {msg && (
          <p className={`text-xs inline-flex items-start gap-1.5 ${msg.kind === "ok" ? "text-emerald-400" : "text-amber-400"}`}>
            <AlertCircle size={12} className="mt-0.5 flex-shrink-0" /> <span>{msg.text}</span>
          </p>
        )}
      </div>

      {/* ── Daily schedule ── */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 grid gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2">
            <CalendarClock size={15} className="text-primary" />
            <h2 className="text-sm font-semibold text-[var(--text-1)]">Run daily automatically</h2>
          </div>
          <label className="inline-flex items-center gap-2 cursor-pointer select-none">
            <span className={`text-xs font-medium ${schedule?.enabled ? "text-emerald-400" : "text-[var(--text-3)]"}`}>
              {schedule?.enabled ? "On" : "Off"}
            </span>
            <input
              type="checkbox"
              className="sr-only peer"
              checked={Boolean(schedule?.enabled)}
              disabled={savingSchedule}
              onChange={(e) => saveSchedule({ enabled: e.target.checked, promptId: promptId || undefined })}
            />
            <span className="relative h-5 w-9 rounded-full bg-[var(--bg-elevated)] border border-[var(--border)] peer-checked:bg-primary transition after:absolute after:left-0.5 after:top-0.5 after:h-4 after:w-4 after:rounded-full after:bg-white after:transition peer-checked:after:translate-x-4" />
          </label>
        </div>
        <p className="text-xs text-[var(--text-3)] -mt-1 max-w-2xl">
          Each morning, analyzes the previous day&apos;s reached calls across every campaign with the prompt selected
          above. This creates a standing daily OpenAI cost — leave it off unless you want continuous coverage.
        </p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-[var(--text-3)] font-mono">
          <span>Prompt: {prompts.find((p) => p.id === (schedule?.promptId ?? promptId))?.title ?? "—"}</span>
          {schedule?.lastRunAt && <span>Last run: {fmt(schedule.lastRunAt)}</span>}
          {schedule?.lastRunSummary && <span>· {schedule.lastRunSummary}</span>}
        </div>
      </div>

      {/* ── Live batches + results (all campaigns) ── */}
      <AnalysisHistory showBatches refreshKey={refreshKey} fromHref="/qa-prompt-testing" />
    </div>
  );
}
