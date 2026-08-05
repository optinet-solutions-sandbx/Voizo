// src/app/qa-prompt-testing/[campaignId]/[callId]/page.tsx
//
// QA Prompt Testing — the call detail / tester. A replica of the ai-chat-qa-tool's
// analysis-history detail, adapted for a Voizo CALL: transcript + audio, customer
// (campaign_numbers_v2), campaign + call context, a prompt picker from the library,
// and Run QA. Data: GET /api/qa-prompt-testing/call/[id] + /prompts.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { ArrowLeft } from "lucide-react";
import CallAnalysisDetail, { type QaCallClient, type QaPromptClient } from "@/components/qa/CallAnalysisDetail";

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

export default function QaCallDetailPage() {
  const params = useParams<{ campaignId: string; callId: string }>();
  const campaignId = String(params?.campaignId ?? "");
  const callId = String(params?.callId ?? "");

  const [call, setCall] = useState<QaCallClient | null>(null);
  const [prompts, setPrompts] = useState<QaPromptClient[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotFound(false);
    try {
      const [callRes, promptRes] = await Promise.all([
        fetch(`/api/qa-prompt-testing/call/${encodeURIComponent(callId)}`, { cache: "no-store" }),
        fetch(`/api/qa-prompt-testing/prompts`, { cache: "no-store" }),
      ]);
      if (callRes.status === 404) {
        setNotFound(true);
        return;
      }
      if (!callRes.ok) throw new Error(`HTTP ${callRes.status}`);
      const { call } = (await callRes.json()) as { call: QaCallClient };
      setCall(call);
      if (promptRes.ok) {
        const { prompts } = (await promptRes.json()) as { prompts: QaPromptClient[] };
        setPrompts(prompts);
      }
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load call");
    } finally {
      setLoading(false);
    }
  }, [callId]);

  useEffect(() => {
    if (callId) load();
  }, [callId, load]);

  const backHref = `/qa-prompt-testing/${campaignId}`;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (notFound || (!call && !error)) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6 gap-3">
        <h2 className="text-base font-semibold text-[var(--text-1)]">Call not found</h2>
        <p className="text-sm text-[var(--text-3)]">It may have been deleted.</p>
        <Link href={backHref} className="text-sm text-primary hover:opacity-80 font-medium transition">
          ← Back to conversations
        </Link>
      </div>
    );
  }

  if (error || !call) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-center p-6 gap-3">
        <h2 className="text-base font-semibold text-[var(--text-1)]">Couldn&apos;t load this call</h2>
        <p className="text-sm text-[var(--text-3)] font-mono">{error}</p>
        <button onClick={load} className="text-sm text-primary hover:opacity-80 font-medium transition">
          Retry
        </button>
      </div>
    );
  }

  const title = call.customer.displayName || call.customer.phone || "Call";

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden">
      {/* metadata banner */}
      <div className="flex items-center gap-3 px-4 sm:px-6 py-2 bg-primary/10 border-b border-primary/20 flex-shrink-0 text-xs text-[var(--text-2)] flex-wrap">
        <span className="font-semibold text-[var(--text-1)]">Testing prompt on call</span>
        <span className="text-[var(--text-3)]">·</span>
        <span className="truncate max-w-[220px]">{title}</span>
        {call.createdAt && (
          <>
            <span className="text-[var(--text-3)]">·</span>
            <span>{fmtDateTime(call.createdAt)}</span>
          </>
        )}
        <Link href={backHref} className="ml-auto inline-flex items-center gap-1 text-primary hover:opacity-80 font-medium transition">
          <ArrowLeft size={13} /> Back
        </Link>
      </div>

      <div className="flex-1 min-h-0 p-3 sm:p-4">
        <CallAnalysisDetail call={call} prompts={prompts} />
      </div>
    </div>
  );
}
