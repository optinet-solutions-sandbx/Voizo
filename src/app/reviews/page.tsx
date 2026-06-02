// src/app/reviews/page.tsx
//
// Reviews landing — a per-campaign coverage list. Each row: real-conversation
// count, how many the system marked goal-reached, and your labeling progress.
// Click a campaign to label its calls (good / bad / unsure + audio).
// Data: GET /api/reviews/campaigns. Server-side service role only.

"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ChevronRight, ClipboardList, FlaskConical } from "lucide-react";

interface ReviewCampaign {
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  conversationCount: number;
  goalReachedCount: number;
  labeledCount: number;
}
interface CampaignsResponse { campaigns: ReviewCampaign[]; reviewer: string }

export default function ReviewsPage() {
  const [data, setData] = useState<CampaignsResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [testOnly, setTestOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reviews/campaigns?testOnly=${testOnly}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as CampaignsResponse);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load campaigns");
    } finally {
      setLoading(false);
    }
  }, [testOnly]);

  useEffect(() => { load(); }, [load]);

  const totals = useMemo(() => {
    const cs = data?.campaigns ?? [];
    return {
      campaigns: cs.length,
      conversations: cs.reduce((s, c) => s + c.conversationCount, 0),
      goalReached: cs.reduce((s, c) => s + c.goalReachedCount, 0),
      labeled: cs.reduce((s, c) => s + c.labeledCount, 0),
    };
  }, [data]);

  return (
    <div className="p-6 max-w-[1100px] mx-auto w-full grid gap-5">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-[26px] font-bold tracking-tight flex items-center gap-2.5">
            <ClipboardList size={24} className="text-blue-400" />
            Reviews
          </h1>
          <p className="text-sm text-[var(--text-3)] mt-1">
            Pick a campaign to label its real conversations good / bad — your verdict is the ground truth the AI judge calibrates against.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
          <label className="inline-flex items-center gap-2 text-xs text-[var(--text-2)] cursor-pointer select-none px-2.5 py-1.5 rounded-lg border border-[var(--border)] hover:border-[var(--border-2)] transition">
            <input type="checkbox" checked={testOnly} onChange={(e) => setTestOnly(e.target.checked)} className="accent-blue-500" />
            <FlaskConical size={12} /> Test campaigns only
          </label>
        </div>
      </div>

      {/* totals strip */}
      <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5 flex flex-wrap items-center gap-x-8 gap-y-2">
        <Total label="Campaigns" value={loading ? "—" : totals.campaigns} />
        <Total label="Conversations" value={loading ? "—" : totals.conversations} />
        <Total label="Goal reached" value={loading ? "—" : totals.goalReached} tone="text-emerald-400" />
        <Total label="Labeled by you" value={loading ? "—" : totals.labeled} tone="text-blue-400" />
        <p className="text-[11px] text-[var(--text-3)] basis-full">
          Voicemails, no-answers, and AI-only calls are filtered out — only genuine customer conversations appear.
        </p>
      </section>

      {loading ? (
        <SkeletonRows count={6} />
      ) : !data || data.campaigns.length === 0 ? (
        <EmptyState testOnly={testOnly} />
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
          {data.campaigns.map((c) => <CampaignRow key={c.campaignId} c={c} />)}
        </div>
      )}
    </div>
  );
}

function Total({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-xl font-bold tabular-nums ${tone ?? "text-[var(--text-1)]"}`}>{value}</span>
      <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wider">{label}</span>
    </div>
  );
}

function CampaignRow({ c }: { c: ReviewCampaign }) {
  const pctGoal = c.conversationCount > 0 ? Math.round((c.goalReachedCount / c.conversationCount) * 100) : 0;
  const pctLabeled = c.conversationCount > 0 ? Math.round((c.labeledCount / c.conversationCount) * 100) : 0;
  const done = c.labeledCount >= c.conversationCount && c.conversationCount > 0;

  return (
    <Link href={`/reviews/${c.campaignId}`} className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium text-[var(--text-1)] truncate">{c.campaignName}</span>
          {c.isTest && (
            <span className="text-[10px] uppercase tracking-wider font-mono px-1.5 py-0.5 rounded-full border bg-violet-500/15 text-violet-400 border-violet-500/30 flex-shrink-0">test</span>
          )}
        </div>
        {/* labeling progress bar */}
        <div className="flex items-center gap-2 mt-1.5">
          <div className="h-1.5 w-32 rounded-full bg-[var(--bg-elevated)] overflow-hidden">
            <div className={`h-full ${done ? "bg-emerald-500" : "bg-blue-500"}`} style={{ width: `${pctLabeled}%` }} />
          </div>
          <span className="text-[10px] text-[var(--text-3)] font-mono">{c.labeledCount}/{c.conversationCount} labeled</span>
        </div>
      </div>

      <div className="hidden sm:flex items-center gap-5 flex-shrink-0 text-right">
        <Metric value={c.conversationCount} label="convos" />
        <Metric value={`${c.goalReachedCount}`} sub={`${pctGoal}%`} label="goal" tone="text-emerald-400" title="Calls the system marked goal_reached" />
      </div>

      <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
    </Link>
  );
}

function Metric({ value, sub, label, tone, title }: { value: string | number; sub?: string; label: string; tone?: string; title?: string }) {
  return (
    <div className="min-w-[52px]" title={title}>
      <div className="flex items-baseline justify-end gap-1">
        <span className={`text-sm font-bold tabular-nums ${tone ?? "text-[var(--text-1)]"}`}>{value}</span>
        {sub && <span className="text-[10px] text-[var(--text-3)] font-mono">{sub}</span>}
      </div>
      <div className="text-[10px] text-[var(--text-3)] uppercase tracking-wider">{label}</div>
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="flex items-center gap-4 px-5 py-4">
          <div className="flex-1 space-y-2">
            <div className="h-3.5 w-2/5 rounded bg-[var(--bg-elevated)] animate-pulse" />
            <div className="h-1.5 w-32 rounded bg-[var(--bg-elevated)] animate-pulse" />
          </div>
          <div className="h-6 w-24 rounded bg-[var(--bg-elevated)] animate-pulse" />
        </div>
      ))}
    </div>
  );
}

function EmptyState({ testOnly }: { testOnly: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <div className="w-12 h-12 rounded-full bg-[var(--bg-elevated)] grid place-items-center text-[var(--text-3)]">
        <ClipboardList size={20} />
      </div>
      <p className="text-sm text-[var(--text-2)]">No campaigns with real conversations{testOnly ? " in the test set" : ""} yet.</p>
      <p className="text-xs text-[var(--text-3)]">Conversations appear once calls complete with a customer on the line.</p>
    </div>
  );
}
