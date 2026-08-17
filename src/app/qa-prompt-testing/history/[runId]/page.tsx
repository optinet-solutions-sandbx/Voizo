// src/app/qa-prompt-testing/history/[runId]/page.tsx
//
// Analysis History — replay one stored run. Loads the run (its prompt + result) and
// the call it scored, and renders the same detail view seeded with the stored prompt
// and analysis (transcript + audio + customer/campaign alongside). Re-running is still
// available (it just overwrites nothing — a fresh run would go through Bulk analysis).
//
// `?from=<path>` sets where "Back" returns — so opening a result from a campaign's
// Bulk-analysis page returns there (to pick another), not to the global History tab.

"use client";

import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft } from "lucide-react";
import CallAnalysisDetail, { type QaCallClient, type QaPromptClient } from "@/components/qa/CallAnalysisDetail";

interface RunRow {
  id: string;
  callId: string;
  campaignId: string;
  promptId: string | null;
  promptTitle: string | null;
  promptContent: string;
  summary: string | null;
  scoredBy: string | null;
  analyzedAt: string;
}

const fmtDateTime = (iso: string | null) => {
  if (!iso) return "";
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return "";
  }
};

// Only honor an internal QA-tool path (no open-redirect via a crafted ?from).
function safeBack(from: string | null): { href: string; label: string } {
  if (from && /^\/qa-prompt-testing(\/|$)/.test(from)) {
    return { href: from, label: from.includes("/batch") ? "Bulk analysis" : "Back" };
  }
  return { href: "/qa-prompt-testing", label: "History" };
}

function AnalysisRunPageInner() {
  const params = useParams<{ runId: string }>();
  const runId = String(params?.runId ?? "");
  const searchParams = useSearchParams();
  const back = useMemo(() => safeBack(searchParams?.get("from") ?? null), [searchParams]);

  const [run, setRun] = useState<RunRow | null>(null);
  const [call, setCall] = useState<QaCallClient | null>(null);
  const [prompts, setPrompts] = useState<QaPromptClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const [runRes, promptRes] = await Promise.all([
        fetch(`/api/qa-prompt-testing/runs/${encodeURIComponent(runId)}`, { cache: "no-store" }),
        fetch("/api/qa-prompt-testing/prompts", { cache: "no-store" }),
      ]);
      if (runRes.status === 404) {
        setNotFound(true);
        return;
      }
      if (!runRes.ok) throw new Error(`HTTP ${runRes.status}`);
      const { run, call } = (await runRes.json()) as { run: RunRow; call: QaCallClient };
      setRun(run);
      setCall(call);
      if (promptRes.ok) setPrompts(((await promptRes.json()) as { prompts: QaPromptClient[] }).prompts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load analysis run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    if (runId) load();
  }, [runId, load]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || (!run && !error)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6 gap-3">
        <h2 className="text-base font-semibold text-[var(--text-1)]">Analysis run not found</h2>
        <p className="text-sm text-[var(--text-3)]">It may have been deleted.</p>
        <Link href={back.href} className="text-sm text-primary hover:opacity-80 font-medium transition">
          ← Back
        </Link>
      </div>
    );
  }

  if (error || !run || !call) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6 gap-3">
        <h2 className="text-base font-semibold text-[var(--text-1)]">Couldn&apos;t load this run</h2>
        <p className="text-sm text-[var(--text-3)] font-mono">{error}</p>
        <button onClick={load} className="text-sm text-primary hover:opacity-80 font-medium transition">Retry</button>
      </div>
    );
  }

  const title = call.customer.displayName || call.customer.phone || "Call";

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2 bg-primary/10 border-b border-primary/20 flex-shrink-0 text-xs text-[var(--text-2)] flex-wrap">
        <span className="font-semibold text-[var(--text-1)]">Analysis run</span>
        <span className="text-[var(--text-3)]">·</span>
        <span className="truncate max-w-[200px]">{title}</span>
        <span className="text-[var(--text-3)]">·</span>
        <span>{fmtDateTime(run.analyzedAt)}</span>
        {run.promptTitle && (
          <>
            <span className="text-[var(--text-3)]">·</span>
            <span>Prompt: <span className="font-medium text-[var(--text-1)]">{run.promptTitle}</span></span>
          </>
        )}
        {run.scoredBy && (
          <>
            <span className="text-[var(--text-3)]">·</span>
            <span>Scored by <span className="font-medium text-[var(--text-1)]">{run.scoredBy}</span>{run.scoredBy === "gpt-5.4" ? " (double-check)" : ""}</span>
          </>
        )}
        <Link href={back.href} className="ml-auto inline-flex items-center gap-1 text-primary hover:opacity-80 font-medium transition">
          <ArrowLeft size={13} /> {back.label}
        </Link>
      </div>

      <div className="flex-1 min-h-0 p-3 sm:p-4 flex flex-col">
        <CallAnalysisDetail
          call={call}
          prompts={prompts}
          initialPromptContent={run.promptContent}
          initialPromptTitle={run.promptTitle}
          initialAnalysis={run.summary}
        />
      </div>
    </div>
  );
}

export default function AnalysisRunPage() {
  return (
    <Suspense
      fallback={
        <div className="flex items-center justify-center h-64">
          <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      }
    >
      <AnalysisRunPageInner />
    </Suspense>
  );
}
