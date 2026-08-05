// src/app/qa-prompt-testing/[campaignId]/page.tsx
//
// QA Prompt Testing — the conversations in one campaign. Pick a conversation to
// open the tester. Reuses GET /api/reviews/queue?campaignId=… (real conversations
// only, each with a transcript + audio).

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertCircle, ArrowLeft, ChevronRight, Target, Volume2, VolumeX } from "lucide-react";

interface QueueItem {
  callId: string;
  campaignId: string;
  campaignName: string;
  isTest: boolean;
  createdAt: string;
  durationSeconds: number | null;
  status: string;
  goalReached: boolean | null;
  transcript: string;
  audioUrl: string | null;
}

const fmtDate = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return "";
  }
};
const fmtDur = (s: number | null) => (s == null ? "—" : s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);
const snippet = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 120);

export default function CampaignCallsPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = String(params?.campaignId ?? "");
  const [items, setItems] = useState<QueueItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reviews/queue?campaignId=${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { items } = (await r.json()) as { items: QueueItem[] };
      setItems(items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }, [campaignId]);

  useEffect(() => {
    if (campaignId) load();
  }, [campaignId, load]);

  const campaignName = items?.[0]?.campaignName ?? "Campaign";
  const sorted = useMemo(
    () => [...(items ?? [])].sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0)),
    [items],
  );

  return (
    <div className="p-4 max-w-[1100px] mx-auto w-full grid gap-4">
      <div>
        <Link
          href="/qa-prompt-testing"
          className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition mb-2"
        >
          <ArrowLeft size={13} /> All campaigns
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)] truncate max-w-[760px]">
              {loading ? "Loading…" : campaignName}
            </h1>
            <p className="text-xs text-[var(--text-3)] mt-0.5">
              {items ? `${items.length} conversation${items.length === 1 ? "" : "s"} · pick one to test a prompt` : ""}
            </p>
          </div>
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
        </div>
      </div>

      {loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />
          ))}
        </div>
      ) : sorted.length === 0 ? (
        <div className="text-center py-16 text-sm text-[var(--text-3)]">
          No real conversations in this campaign. Voicemails, no-answers, and AI-only calls are filtered out.
        </div>
      ) : (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden divide-y divide-[var(--border)]">
          {sorted.map((it) => (
            <Link
              key={it.callId}
              href={`/qa-prompt-testing/${campaignId}/${it.callId}`}
              className="flex items-center gap-4 px-4 sm:px-5 py-3.5 hover:bg-[var(--bg-hover)] transition group"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--text-3)]">
                  <span className="text-[var(--text-2)]">{fmtDate(it.createdAt)}</span>
                  <span>·</span>
                  <span>{fmtDur(it.durationSeconds)}</span>
                  <span>·</span>
                  <span>{it.status.replace(/_/g, " ")}</span>
                  {it.audioUrl ? <Volume2 size={11} className="text-[var(--text-3)]" /> : <VolumeX size={11} className="text-[var(--text-3)]" />}
                </div>
                <p className="text-xs text-[var(--text-2)] mt-1 truncate">{snippet(it.transcript) || "—"}</p>
              </div>
              <span
                className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border flex-shrink-0 ${
                  it.goalReached
                    ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                    : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
                }`}
                title="The system's success flag (goal_reached)"
              >
                <Target size={9} /> {it.goalReached ? "goal" : "no goal"}
              </span>
              <ChevronRight size={16} className="text-[var(--text-3)] group-hover:text-[var(--text-1)] transition flex-shrink-0" />
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
