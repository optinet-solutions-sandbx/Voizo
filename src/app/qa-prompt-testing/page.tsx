// src/app/qa-prompt-testing/page.tsx
//
// QA Prompt Testing — landing. Two tabs:
//   • Campaigns    → pick a campaign, then a call, then test a prompt against it.
//   • Prompt Library → manage the reusable QA prompts.
// Campaign data reuses GET /api/reviews/campaigns (the same real-conversation
// aggregate the Reviews tool uses).

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronRight, FlaskConical, ClipboardList, Library } from "lucide-react";
import { campaignRegion } from "@/lib/campaignRegion";
import { SectionTick } from "../analytics/SectionIsland";
import PromptLibrary from "@/components/qa/PromptLibrary";

interface ReviewCampaign {
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  conversationCount: number;
  totalCallCount: number;
  goalReachedCount: number;
  labeledCount: number;
}

export default function QaPromptTestingPage() {
  const [tab, setTab] = useState<"campaigns" | "library">("campaigns");
  const [campaigns, setCampaigns] = useState<ReviewCampaign[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/reviews/campaigns?testOnly=false", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { campaigns } = (await r.json()) as { campaigns: ReviewCampaign[] };
      setCampaigns(campaigns);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "campaigns") load();
  }, [tab, load]);

  const sorted = useMemo(
    () => [...(campaigns ?? [])].sort((a, b) => b.conversationCount - a.conversationCount),
    [campaigns],
  );

  const tabCls = (on: boolean) =>
    `inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium transition whitespace-nowrap ${
      on ? "bg-[var(--bg-elevated)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-1)]"
    }`;

  return (
    <div className="p-4 max-w-[1100px] mx-auto w-full grid gap-4">
      <div className="min-w-0">
        <div className="flex items-center gap-2.5">
          <SectionTick color="#a78bfa" />
          <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">QA Prompt Testing</h1>
        </div>
        <p className="mt-1 max-w-3xl text-xs text-[var(--text-3)]">
          Test a QA prompt against a real call. Pick a campaign, then a conversation, then run a prompt from your{" "}
          <strong className="text-[var(--text-2)]">Prompt Library</strong> against the call transcript — with audio,
          customer, and campaign context alongside.
        </p>
      </div>

      <div className="flex w-fit gap-1 p-1 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl">
        <button onClick={() => setTab("campaigns")} className={tabCls(tab === "campaigns")}>
          <ClipboardList size={13} /> Campaigns
        </button>
        <button onClick={() => setTab("library")} className={tabCls(tab === "library")}>
          <Library size={13} /> Prompt Library
        </button>
      </div>

      {tab === "library" ? (
        <PromptLibrary />
      ) : loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />
          ))}
        </div>
      ) : error ? (
        <p className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
          <AlertCircle size={11} /> {error}
        </p>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">
          No campaigns with real conversations yet.
        </div>
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
          {sorted.map((c) => (
            <Link
              key={c.campaignId}
              href={`/qa-prompt-testing/${c.campaignId}`}
              className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-sm font-medium text-[var(--text-1)] truncate">{c.campaignName}</span>
                  {campaignRegion(c.campaignName) && (
                    <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-primary/10 text-primary border-primary/25 flex-shrink-0">
                      {campaignRegion(c.campaignName)}
                    </span>
                  )}
                  {c.isTest && (
                    <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-violet-500/15 text-violet-400 border-violet-500/30 flex-shrink-0 inline-flex items-center gap-1">
                      <FlaskConical size={9} /> test
                    </span>
                  )}
                </div>
                <p className="text-[10px] text-[var(--text-3)] font-mono mt-1">
                  {c.conversationCount} conversation{c.conversationCount === 1 ? "" : "s"} · {c.totalCallCount} calls
                </p>
              </div>
              <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
