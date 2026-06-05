// src/app/reviews/[campaignId]/page.tsx
//
// Reviews drill-down — label one campaign's real conversations good / bad,
// with audio playback + the live premise-check (agree vs disagree with the
// system's goal_reached). Data: GET /api/reviews/queue?campaignId=… ;
// POST /api/reviews/label. Server-side service role only.

"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertCircle, ArrowLeft, HelpCircle, Target, ThumbsDown, ThumbsUp, VolumeX,
} from "lucide-react";
import { JudgeScorecard, type JudgeCalibration } from "@/components/reviews/JudgeScorecard";
import { JudgeVerdictChip, type JudgeScore } from "@/components/reviews/JudgeVerdictChip";

type Verdict = "good" | "bad" | "unsure";

interface CallLabel { verdict: Verdict; reason: string | null; labeledBy: string; updatedAt: string; }
interface QueueItem {
  callId: string; campaignId: string; campaignName: string; isTest: boolean;
  createdAt: string; durationSeconds: number | null; status: string;
  goalReached: boolean | null; transcript: string; audioUrl: string | null; yourLabel: CallLabel | null;
}
interface QueueResponse { items: QueueItem[]; total: number; reviewer: string; }
interface JudgeData { judgeEnabled: boolean; calibration: JudgeCalibration; scores: Record<string, JudgeScore>; }

export default function CampaignReviewPage() {
  const params = useParams<{ campaignId: string }>();
  const campaignId = String(params?.campaignId ?? "");
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [judge, setJudge] = useState<JudgeData | null>(null);
  const [gradingId, setGradingId] = useState<string | null>(null);
  const [gradingAll, setGradingAll] = useState(false);
  const [gradeMsg, setGradeMsg] = useState<string | null>(null);

  // Judge data is best-effort — the labeling UI must still load if it fails. Re-run
  // after grading so the scorecard's agreement/κ updates without a manual refresh.
  const loadJudge = useCallback(async () => {
    try {
      const jr = await fetch(`/api/qa/campaign/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      if (jr.ok) setJudge((await jr.json()) as JudgeData);
    } catch {
      /* swallow — judge panel just shows its loading/empty state */
    }
  }, [campaignId]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch(`/api/reviews/queue?campaignId=${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setData((await r.json()) as QueueResponse);
      setError(null);
      await loadJudge();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load conversations");
    } finally {
      setLoading(false);
    }
  }, [campaignId, loadJudge]);

  useEffect(() => { if (campaignId) load(); }, [campaignId, load]);

  const submitLabel = useCallback(async (callId: string, verdict: Verdict, reason: string | null) => {
    setSavingId(callId);
    setError(null);
    try {
      const r = await fetch("/api/reviews/label", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId, verdict, reason }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      const { label } = (await r.json()) as { label: CallLabel };
      setData((prev) =>
        prev ? { ...prev, items: prev.items.map((it) => (it.callId === callId ? { ...it, yourLabel: label } : it)) } : prev,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save label");
    } finally {
      setSavingId(null);
    }
  }, []);

  const gradeCall = useCallback(async (callId: string) => {
    setGradingId(callId);
    setError(null);
    try {
      const r = await fetch(`/api/qa/score/${encodeURIComponent(callId)}`, { method: "POST" });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string; skipped?: string };
        throw new Error(b.error || b.skipped || `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { verdict?: unknown; skipped?: string };
      if (body.skipped && !body.verdict) setError(`AI judge skipped this call: ${body.skipped}`);
      await loadJudge(); // refresh the chip + the scorecard's agreement/κ
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to grade call");
    } finally {
      setGradingId(null);
    }
  }, [loadJudge]);

  const gradeAll = useCallback(async () => {
    setGradingAll(true);
    setGradeMsg(null);
    setError(null);
    try {
      const r = await fetch(`/api/qa/campaign/${encodeURIComponent(campaignId)}/grade`, { method: "POST" });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { scored: number; skipped: number; candidates: number };
      setGradeMsg(
        body.candidates === 0
          ? "All real conversations here are already graded."
          : `Graded ${body.scored} · skipped ${body.skipped} (voicemail / short / etc.)`,
      );
      await loadJudge();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to grade campaign");
    } finally {
      setGradingAll(false);
    }
  }, [campaignId, loadJudge]);

  const stats = useMemo(() => agreementStats(data?.items ?? []), [data]);
  const campaignName = data?.items[0]?.campaignName ?? "Campaign";

  const [goalFilter, setGoalFilter] = useState<"all" | "true" | "false">("all");
  const counts = useMemo(() => {
    const items = data?.items ?? [];
    return {
      all: items.length,
      true: items.filter((i) => i.goalReached === true).length,
      false: items.filter((i) => i.goalReached !== true).length,
    };
  }, [data]);
  const visibleItems = useMemo(() => {
    const items = data?.items ?? [];
    const filtered =
      goalFilter === "all"
        ? items
        : items.filter((i) => (goalFilter === "true" ? i.goalReached === true : i.goalReached !== true));
    // longest calls first — the substantive conversations worth listening to
    return [...filtered].sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0));
  }, [data, goalFilter]);

  return (
    <div className="p-6 max-w-[1100px] mx-auto w-full grid gap-5">
      <div>
        <Link href="/reviews" className="inline-flex items-center gap-1.5 text-xs text-[var(--text-3)] hover:text-[var(--text-1)] transition mb-2">
          <ArrowLeft size={13} /> All campaigns
        </Link>
        <div className="flex items-end justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h1 className="text-[24px] font-bold tracking-tight truncate max-w-[760px]">{loading ? "Loading…" : campaignName}</h1>
            <p className="text-sm text-[var(--text-3)] mt-1">{data ? `${data.total} conversation${data.total === 1 ? "" : "s"} to review` : ""}</p>
          </div>
          {error && (
            <span className="text-[11px] text-amber-400 font-mono inline-flex items-center gap-1">
              <AlertCircle size={11} /> {error}
            </span>
          )}
        </div>
      </div>

      <AgreementBar stats={stats} loading={loading} />

      <JudgeScorecard
        judgeEnabled={judge?.judgeEnabled ?? false}
        calibration={judge?.calibration ?? null}
        scoredCount={judge ? Object.keys(judge.scores).length : 0}
        loading={loading}
        onGradeAll={gradeAll}
        gradingAll={gradingAll}
        gradeMsg={gradeMsg}
      />

      {!loading && data && data.items.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wider mr-1">Show</span>
          <FilterChip active={goalFilter === "all"} onClick={() => setGoalFilter("all")}>All · {counts.all}</FilterChip>
          <FilterChip active={goalFilter === "true"} tone="good" onClick={() => setGoalFilter("true")}>Goal true · {counts.true}</FilterChip>
          <FilterChip active={goalFilter === "false"} tone="bad" onClick={() => setGoalFilter("false")}>Goal false · {counts.false}</FilterChip>
          <span className="text-[10px] text-[var(--text-3)] ml-auto font-mono">longest first</span>
        </div>
      )}

      {loading ? (
        <SkeletonCards count={3} />
      ) : !data || data.items.length === 0 ? (
        <EmptyState />
      ) : visibleItems.length === 0 ? (
        <div className="text-center text-sm text-[var(--text-3)] py-10">No conversations match this filter.</div>
      ) : (
        <div className="grid gap-4">
          {visibleItems.map((it) => (
            <ReviewCard
              key={it.callId}
              item={it}
              saving={savingId === it.callId}
              onLabel={submitLabel}
              judgeScore={judge?.scores[it.callId] ?? null}
              judgeEnabled={judge?.judgeEnabled ?? false}
              grading={gradingId === it.callId}
              onGrade={() => gradeCall(it.callId)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────

interface Stats { total: number; labeled: number; agree: number; disagree: number; unsure: number; }

function agreementStats(items: QueueItem[]): Stats {
  let labeled = 0, agree = 0, disagree = 0, unsure = 0;
  for (const it of items) {
    if (!it.yourLabel) continue;
    labeled += 1;
    const v = it.yourLabel.verdict;
    if (v === "unsure") { unsure += 1; continue; }
    const systemSuccess = it.goalReached === true;
    if ((v === "good") === systemSuccess) agree += 1;
    else disagree += 1;
  }
  return { total: items.length, labeled, agree, disagree, unsure };
}

function AgreementBar({ stats, loading }: { stats: Stats; loading: boolean }) {
  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 sm:p-5">
      <div className="flex items-center gap-2 mb-3">
        <Target size={14} className="text-amber-400" />
        <span className="text-[13px] font-semibold">Premise check — your verdict vs the system&apos;s success flag</span>
      </div>
      {loading ? (
        <div className="h-5 w-2/3 rounded bg-[var(--bg-elevated)] animate-pulse" />
      ) : (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <Stat label="Labeled" value={`${stats.labeled} / ${stats.total}`} tone="text-[var(--text-1)]" />
          <Stat label="Agree with system" value={stats.agree} tone="text-emerald-400" />
          <Stat label="Disagree (ruler signal)" value={stats.disagree} tone="text-red-400" />
          <Stat label="Unsure" value={stats.unsure} tone="text-[var(--text-3)]" />
          <p className="text-[11px] text-[var(--text-3)] basis-full">
            Disagreements = calls where your good/bad differs from the system&apos;s <span className="font-mono">goal_reached</span> — the fuzzy-ruler evidence.
          </p>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, tone }: { label: string; value: string | number; tone: string }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className={`text-lg font-bold tabular-nums ${tone}`}>{value}</span>
      <span className="text-[11px] text-[var(--text-3)] uppercase tracking-wider">{label}</span>
    </div>
  );
}

function ReviewCard({
  item, saving, onLabel, judgeScore, judgeEnabled, grading, onGrade,
}: {
  item: QueueItem; saving: boolean; onLabel: (callId: string, verdict: Verdict, reason: string | null) => void;
  judgeScore: JudgeScore | null; judgeEnabled: boolean; grading: boolean; onGrade: () => void;
}) {
  const [reason, setReason] = useState(item.yourLabel?.reason ?? "");
  const current = item.yourLabel?.verdict ?? null;

  return (
    <section className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
        <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--text-3)]">
          <span>{item.durationSeconds != null ? `${item.durationSeconds}s` : "—"}</span>
          <span>·</span>
          <span>{item.status.replace(/_/g, " ")}</span>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${
              item.goalReached
                ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"
                : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
            }`}
            title="The system's success flag (goal_reached)"
          >
            <Target size={9} /> goal {item.goalReached ? "true" : "false"}
          </span>
          <JudgeVerdictChip score={judgeScore} judgeEnabled={judgeEnabled} grading={grading} onGrade={onGrade} />
        </div>
      </div>

      {item.audioUrl ? (
        <audio controls preload="none" src={item.audioUrl} className="w-full mb-3" style={{ height: 38 }}>
          Your browser does not support audio playback.
        </audio>
      ) : (
        <div className="text-[11px] text-[var(--text-3)] mb-3 inline-flex items-center gap-1.5">
          <VolumeX size={12} /> no recording for this call
        </div>
      )}

      <TranscriptView text={item.transcript} />

      <div className="flex items-center gap-2 flex-wrap mt-4">
        <VerdictButton active={current === "good"} disabled={saving} tone="good" onClick={() => onLabel(item.callId, "good", reason || null)}>
          <ThumbsUp size={13} /> Good
        </VerdictButton>
        <VerdictButton active={current === "bad"} disabled={saving} tone="bad" onClick={() => onLabel(item.callId, "bad", reason || null)}>
          <ThumbsDown size={13} /> Bad
        </VerdictButton>
        <VerdictButton active={current === "unsure"} disabled={saving} tone="unsure" onClick={() => onLabel(item.callId, "unsure", reason || null)}>
          <HelpCircle size={13} /> Unsure
        </VerdictButton>
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="one-line reason (optional)"
          maxLength={500}
          className="flex-1 min-w-[180px] text-xs bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg px-2.5 py-1.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-blue-500/50"
        />
        {current && <span className="text-[10px] text-[var(--text-3)] font-mono">{saving ? "saving…" : "saved"}</span>}
      </div>
    </section>
  );
}

function VerdictButton({
  active, disabled, tone, onClick, children,
}: {
  active: boolean; disabled: boolean; tone: "good" | "bad" | "unsure"; onClick: () => void; children: React.ReactNode;
}) {
  const tones: Record<string, string> = {
    good: active ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50" : "text-[var(--text-2)] border-[var(--border)] hover:border-emerald-500/40 hover:text-emerald-400",
    bad: active ? "bg-red-500/20 text-red-300 border-red-500/50" : "text-[var(--text-2)] border-[var(--border)] hover:border-red-500/40 hover:text-red-400",
    unsure: active ? "bg-[var(--bg-elevated)] text-[var(--text-1)] border-[var(--border-2)]" : "text-[var(--text-3)] border-[var(--border)] hover:text-[var(--text-2)]",
  };
  return (
    <button onClick={onClick} disabled={disabled}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border transition disabled:opacity-50 disabled:cursor-not-allowed ${tones[tone]}`}>
      {children}
    </button>
  );
}

function FilterChip({
  active, tone, onClick, children,
}: { active: boolean; tone?: "good" | "bad"; onClick: () => void; children: React.ReactNode }) {
  const activeCls =
    tone === "good"
      ? "bg-emerald-500/20 text-emerald-300 border-emerald-500/50"
      : tone === "bad"
        ? "bg-red-500/20 text-red-300 border-red-500/50"
        : "bg-blue-500/20 text-blue-300 border-blue-500/50";
  return (
    <button
      onClick={onClick}
      className={`text-xs font-medium px-2.5 py-1 rounded-lg border transition ${active ? activeCls : "text-[var(--text-2)] border-[var(--border)] hover:border-[var(--border-2)] hover:text-[var(--text-1)]"}`}
    >
      {children}
    </button>
  );
}

function TranscriptView({ text }: { text: string }) {
  if (!text || !text.trim()) {
    return <div className="text-xs text-[var(--text-3)] italic py-3">No transcript captured for this call.</div>;
  }
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (
    <div className="max-h-[260px] overflow-y-auto rounded-lg bg-[var(--bg-elevated)]/40 border border-[var(--border)] p-3 flex flex-col gap-1.5">
      {lines.map((line, i) => {
        const isAI = /^(?:AI|Assistant|Bot)\b/i.test(line);
        const isUser = /^(?:User|Customer|Caller|Human)\b/i.test(line);
        return (
          <div key={i} className="text-xs leading-relaxed">
            <span className={isAI ? "text-blue-400 font-medium" : isUser ? "text-[var(--text-1)] font-medium" : "text-[var(--text-2)]"}>{line}</span>
          </div>
        );
      })}
    </div>
  );
}

function SkeletonCards({ count }: { count: number }) {
  return (
    <div className="grid gap-4">
      {Array.from({ length: count }).map((_, i) => (
        <div key={i} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5">
          <div className="h-4 w-1/3 rounded bg-[var(--bg-elevated)] animate-pulse mb-3" />
          <div className="h-24 w-full rounded bg-[var(--bg-elevated)] animate-pulse" />
          <div className="h-8 w-1/2 rounded bg-[var(--bg-elevated)] animate-pulse mt-4" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-16 text-center">
      <p className="text-sm text-[var(--text-2)]">No real conversations in this campaign.</p>
      <p className="text-xs text-[var(--text-3)]">Voicemails, no-answers, and AI-only calls are filtered out.</p>
    </div>
  );
}
