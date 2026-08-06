// src/app/qa-prompt-testing/[campaignId]/batch/page.tsx
//
// Bulk analysis for one campaign — a Voizo-themed replica of the ai-chat-qa-tool
// /batch-analysis flow. Pick a prompt, submit an OpenAI batch over the campaign's
// reached calls (person or voicemail, with a transcript), watch it progress, then
// import the results into Analysis History. Resume/cancel supported.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, ArrowLeft, Layers, RefreshCw } from "lucide-react";

interface QaPrompt { id: string; title: string; content: string; isActive: boolean }
interface BatchJob {
  id: string;
  status: string;
  promptTitle: string | null;
  openaiBatchId: string | null;
  totalConversations: number;
  completedConversations: number;
  failedConversations: number;
  importedCount: number;
  errorMessage: string | null;
  submittedAt: string | null;
  completedAt: string | null;
}

const ACTIVE = new Set(["validating", "in_progress", "finalizing"]);
const POLL_MS = 30_000;

const fmt = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};
const statusLabel = (s: string) => s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const statusCls = (s: string) => {
  if (s === "completed") return "bg-emerald-500/15 text-emerald-400 border-emerald-500/30";
  if (s === "failed" || s === "expired") return "bg-red-500/15 text-red-400 border-red-500/30";
  if (s === "cancelled" || s === "cancelling") return "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]";
  return "bg-primary/15 text-primary border-primary/30";
};
const pct = (a: number, b: number) => (b ? Math.min(100, Math.round((a / b) * 100)) : 0);

export default function CampaignBatchPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = String(params?.campaignId ?? "");

  const [prompts, setPrompts] = useState<QaPrompt[]>([]);
  const [promptId, setPromptId] = useState("");
  const [testLimit, setTestLimit] = useState("");
  const [counts, setCounts] = useState<{ reached: number; unanalyzed: number } | null>(null);

  const [jobs, setJobs] = useState<BatchJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitMsg, setSubmitMsg] = useState<{ kind: "ok" | "warn" | "err"; text: string } | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchJobs = useCallback(async () => {
    try {
      const r = await fetch(`/api/qa-prompt-testing/batch?campaignId=${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      if (r.ok) setJobs(((await r.json()) as { jobs: BatchJob[] }).jobs ?? []);
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  const fetchCounts = useCallback(
    async (pid: string) => {
      try {
        const r = await fetch(
          `/api/qa-prompt-testing/batch/counts?campaignId=${encodeURIComponent(campaignId)}${pid ? `&promptId=${encodeURIComponent(pid)}` : ""}`,
          { cache: "no-store" },
        );
        if (r.ok) setCounts((await r.json()) as { reached: number; unanalyzed: number });
      } catch {
        /* non-fatal */
      }
    },
    [campaignId],
  );

  // Load prompts + jobs once.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch("/api/qa-prompt-testing/prompts", { cache: "no-store" });
        if (r.ok) {
          const { prompts } = (await r.json()) as { prompts: QaPrompt[] };
          setPrompts(prompts);
          const def = prompts.find((p) => p.isActive) ?? prompts[0];
          if (def) setPromptId(def.id);
        }
      } catch {
        /* ignore */
      }
    })();
    fetchJobs();
  }, [fetchJobs]);

  // Recount whenever the chosen prompt changes.
  useEffect(() => {
    if (campaignId) fetchCounts(promptId);
  }, [campaignId, promptId, fetchCounts]);

  // Auto-poll while any job is active.
  useEffect(() => {
    const active = jobs.some((j) => ACTIVE.has(j.status));
    if (active && !pollRef.current) pollRef.current = setInterval(fetchJobs, POLL_MS);
    if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [jobs, fetchJobs]);

  const selectedPrompt = prompts.find((p) => p.id === promptId) ?? null;

  const submit = async () => {
    if (!selectedPrompt) return;
    setSubmitting(true);
    setSubmitMsg(null);
    try {
      const r = await fetch("/api/qa-prompt-testing/batch", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          campaignId,
          promptId: selectedPrompt.id,
          promptTitle: selectedPrompt.title,
          promptContent: selectedPrompt.content,
          ...(testLimit ? { testLimit: parseInt(testLimit, 10) } : {}),
        }),
      });
      const data = (await r.json()) as { totalSubmitted?: number; message?: string; error?: string };
      if (r.status === 429) {
        setSubmitMsg({ kind: "warn", text: data.error ?? "A batch is already in progress." });
        return;
      }
      if (!r.ok) throw new Error(data.error ?? "Submission failed");
      if (data.message && !data.totalSubmitted) {
        setSubmitMsg({ kind: "warn", text: data.message });
      } else {
        setSubmitMsg({
          kind: "ok",
          text: `Submitted ${data.totalSubmitted?.toLocaleString()} call(s). Results are usually ready within minutes (max 24h) — refresh, then Import.`,
        });
      }
      await fetchJobs();
      await fetchCounts(promptId);
    } catch (e) {
      setSubmitMsg({ kind: "err", text: e instanceof Error ? e.message : "Submission failed" });
    } finally {
      setSubmitting(false);
    }
  };

  const importJob = async (job: BatchJob) => {
    setImportingId(job.id);
    try {
      const r = await fetch("/api/qa-prompt-testing/batch", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchJobId: job.id }),
      });
      const data = (await r.json()) as { imported?: number; failed?: number; error?: string };
      if (!r.ok) throw new Error(data.error ?? "Import failed");
      setSubmitMsg({ kind: "ok", text: `Imported ${data.imported ?? 0} result(s)${data.failed ? `, ${data.failed} failed` : ""}. See Analysis History.` });
      await fetchJobs();
    } catch (e) {
      setSubmitMsg({ kind: "err", text: e instanceof Error ? e.message : "Import failed" });
    } finally {
      setImportingId(null);
    }
  };

  const cancelJob = async (job: BatchJob) => {
    if (!confirm(`Cancel this batch (${job.totalConversations.toLocaleString()} calls)?`)) return;
    setCancellingId(job.id);
    try {
      const r = await fetch("/api/qa-prompt-testing/batch", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ batchJobId: job.id }),
      });
      if (!r.ok) throw new Error(((await r.json()) as { error?: string }).error ?? "Cancel failed");
      await fetchJobs();
    } catch (e) {
      setSubmitMsg({ kind: "err", text: e instanceof Error ? e.message : "Cancel failed" });
    } finally {
      setCancellingId(null);
    }
  };

  const hasActive = jobs.some((j) => ACTIVE.has(j.status));
  const msgCls =
    submitMsg?.kind === "ok"
      ? "text-emerald-400 bg-emerald-500/10"
      : submitMsg?.kind === "warn"
        ? "text-amber-300 bg-amber-500/10"
        : "text-red-400 bg-red-500/10";

  return (
    <div className="p-4 max-w-[900px] mx-auto w-full grid gap-4">
      <div>
        <Link
          href={`/qa-prompt-testing/${campaignId}`}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition mb-2"
        >
          <ArrowLeft size={13} /> Back to conversations
        </Link>
        <div className="flex items-center gap-2.5">
          <Layers size={18} className="text-primary" />
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">Bulk Analysis</h1>
        </div>
        <p className="mt-1 max-w-2xl text-xs text-[var(--text-3)]">
          Run a prompt across every <strong className="text-[var(--text-2)]">reached</strong> call in this campaign
          (person or voicemail, with a transcript) via the OpenAI Batch API. Already-analyzed calls are skipped, so
          re-submitting is safe. Results land in Analysis History once imported.
        </p>
      </div>

      {/* Submit card */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 grid gap-3">
        <h2 className="text-sm font-semibold text-[var(--text-1)]">Submit a batch</h2>
        {prompts.length === 0 ? (
          <p className="text-xs text-[var(--text-3)]">
            No prompts in the library.{" "}
            <Link href="/qa-prompt-testing" className="text-primary hover:opacity-80">Add one →</Link>
          </p>
        ) : (
          <>
            <div className="grid gap-1.5">
              <label className="text-[11px] font-medium text-[var(--text-3)]">Prompt</label>
              <select
                value={promptId}
                onChange={(e) => setPromptId(e.target.value)}
                className="w-full bg-[var(--bg-elevated)]/40 border border-[var(--border)] text-[var(--text-1)] text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-primary/50"
              >
                {prompts.map((p) => (
                  <option key={p.id} value={p.id}>{p.title}{p.isActive ? " (default)" : ""}</option>
                ))}
              </select>
            </div>

            <div className="flex items-end gap-4 flex-wrap">
              <div className="grid gap-1.5">
                <label className="text-[11px] font-medium text-[var(--text-3)]">
                  Test limit <span className="text-[var(--text-3)]/70">(optional)</span>
                </label>
                <input
                  inputMode="numeric"
                  value={testLimit}
                  onChange={(e) => setTestLimit(e.target.value.replace(/\D/g, ""))}
                  placeholder="e.g. 5"
                  className="w-28 bg-[var(--bg-elevated)]/40 border border-[var(--border)] text-[var(--text-1)] text-sm rounded-lg px-3 py-2 focus:outline-none focus:border-primary/50 placeholder:text-[var(--text-3)]"
                />
              </div>
              <p className="text-[11px] text-[var(--text-3)] flex-1 min-w-[200px]">
                {counts
                  ? <>{counts.reached.toLocaleString()} reached calls · <span className="text-[var(--text-2)]">{counts.unanalyzed.toLocaleString()} not yet analyzed</span> with this prompt</>
                  : "Counting reached calls…"}
              </p>
            </div>

            {submitMsg && <p className={`text-xs rounded-lg px-3 py-2 ${msgCls}`}>{submitMsg.text}</p>}

            <button
              onClick={submit}
              disabled={submitting || !promptId || (counts?.unanalyzed ?? 0) === 0}
              className="inline-flex w-fit items-center gap-2 bg-primary hover:opacity-90 disabled:opacity-40 text-white text-sm font-medium px-4 py-2 rounded-lg transition"
              title={(counts?.unanalyzed ?? 0) === 0 ? "Nothing new to analyze with this prompt" : "Submit batch"}
            >
              {submitting && <span className="w-4 h-4 border-2 border-white/40 border-t-white rounded-full animate-spin" />}
              {submitting ? "Submitting…" : "Submit batch"}
            </button>
          </>
        )}
      </div>

      {/* Jobs */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-[var(--text-1)]">Batch jobs</h2>
        <button
          onClick={fetchJobs}
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition"
        >
          <RefreshCw size={12} /> Refresh{hasActive ? " · auto every 30s" : ""}
        </button>
      </div>

      {loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 2 }).map((_, i) => <div key={i} className="h-20 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />)}
        </div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-12 text-sm text-[var(--text-3)]">No batch jobs yet. Submit one above.</div>
      ) : (
        <div className="grid gap-2">
          {jobs.map((job) => {
            const importable = job.status === "completed" && job.importedCount < job.totalConversations;
            const progress = pct(job.completedConversations, job.totalConversations);
            return (
              <div key={job.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 grid gap-2">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${statusCls(job.status)}`}>
                      {statusLabel(job.status)}
                    </span>
                    <span className="text-xs text-[var(--text-2)]">{job.totalConversations.toLocaleString()} calls</span>
                    {job.promptTitle && <span className="text-[11px] text-[var(--text-3)] truncate">· {job.promptTitle}</span>}
                    {job.submittedAt && <span className="text-[11px] text-[var(--text-3)]">· {fmt(job.submittedAt)}</span>}
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {importable && (
                      <button
                        onClick={() => importJob(job)}
                        disabled={importingId === job.id}
                        className="inline-flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition"
                      >
                        {importingId === job.id && <span className="w-3 h-3 border border-white/40 border-t-white rounded-full animate-spin" />}
                        {job.importedCount > 0 ? `Resume import (${job.importedCount})` : "Import results"}
                      </button>
                    )}
                    {ACTIVE.has(job.status) && (
                      <button
                        onClick={() => cancelJob(job)}
                        disabled={cancellingId === job.id}
                        className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400 border border-red-400/30 hover:bg-red-400/10 disabled:opacity-50 px-3 py-1.5 rounded-lg transition"
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                </div>

                {(ACTIVE.has(job.status) || job.status === "completed") && (
                  <div>
                    <div className="flex justify-between text-[10px] text-[var(--text-3)] mb-1 font-mono">
                      <span>{job.completedConversations.toLocaleString()} / {job.totalConversations.toLocaleString()} processed</span>
                      <span>{progress}%</span>
                    </div>
                    <div className="h-1.5 bg-[var(--bg-elevated)] rounded-full overflow-hidden">
                      <div className={`h-full rounded-full transition-all ${job.status === "completed" ? "bg-emerald-500" : "bg-primary"}`} style={{ width: `${progress}%` }} />
                    </div>
                  </div>
                )}

                {job.importedCount > 0 && (
                  <p className="text-[11px] text-[var(--text-3)]">
                    {job.importedCount.toLocaleString()} imported to Analysis History
                    {job.failedConversations > 0 ? ` · ${job.failedConversations} failed` : ""}
                  </p>
                )}
                {job.errorMessage && (
                  <p className="text-[11px] text-red-400 inline-flex items-center gap-1"><AlertCircle size={11} /> {job.errorMessage}</p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
