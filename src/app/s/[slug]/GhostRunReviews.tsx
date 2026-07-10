"use client";

import { useCallback, useEffect, useState } from "react";
import {
  AlertTriangle, Check, ChevronDown, Clock, HelpCircle, Loader2, Phone, Target, ThumbsDown, ThumbsUp,
} from "lucide-react";
import type { GhostReviewCall, GhostVerdict } from "@/lib/ghost/ghostLabelData";
import { parseJsonBody } from "@/lib/jsonBody";

// Per-run MANUAL review panel for /s/<slug>. Lists the run's real-conversation
// calls and lets the operator label each good/bad/unsure + notes — stored in
// ghost_call_labels (isolated from the main reviews + AI judge). Internal tool:
// phone numbers are shown in FULL. Dark CSS-var system; Lucide icons; no emoji.

function fmtDuration(sec: number | null): string {
  if (sec == null) return "—";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

export default function GhostRunReviews({ runId }: { runId: string }) {
  const [calls, setCalls] = useState<GhostReviewCall[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await fetch(`/api/ghost/runs/${runId}/calls`, { headers: { "Content-Type": "application/json" } });
      if (!r.ok) {
        const b = (await parseJsonBody(r)) as { error?: string };
        throw new Error(b.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { calls: GhostReviewCall[] };
      setCalls(body.calls);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load calls");
      setCalls([]);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  const saveLabel = useCallback(
    async (callId: string, verdict: GhostVerdict, reason: string): Promise<boolean> => {
      const r = await fetch(`/api/ghost/runs/${runId}/calls/${callId}/label`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ verdict, reason }),
      });
      return r.ok;
    },
    [runId],
  );

  return (
    <section className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 mt-5">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-[var(--text-3)]">
          Review calls{calls ? ` (${calls.length})` : ""}
        </h2>
        <span className="text-[10px] text-[var(--text-3)]">Private (not in the main /reviews queue)</span>
      </div>

      {error && (
        <div className="mb-3 px-3 py-2 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-xs text-red-300 inline-flex items-center gap-2">
          <AlertTriangle size={13} className="text-red-400" /> {error}
        </div>
      )}

      {calls === null ? (
        <div className="py-8 flex items-center justify-center text-[var(--text-3)] text-sm gap-2">
          <Loader2 size={15} className="animate-spin" /> Loading calls…
        </div>
      ) : calls.length === 0 ? (
        <div className="py-8 text-center text-sm text-[var(--text-3)]">No real conversations to review yet.</div>
      ) : (
        <div className="flex flex-col gap-3">
          {calls.map((c) => (
            <GhostCallCard key={c.callId} call={c} onSave={saveLabel} />
          ))}
        </div>
      )}
    </section>
  );
}

function GhostCallCard({
  call,
  onSave,
}: {
  call: GhostReviewCall;
  onSave: (callId: string, verdict: GhostVerdict, reason: string) => Promise<boolean>;
}) {
  const [verdict, setVerdict] = useState<GhostVerdict | null>(call.yourLabel?.verdict ?? null);
  const [reason, setReason] = useState<string>(call.yourLabel?.reason ?? "");
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState(false);

  async function persist(v: GhostVerdict, r: string) {
    setSaving(true);
    setErr(false);
    setSaved(false);
    const ok = await onSave(call.callId, v, r);
    setSaving(false);
    if (ok) {
      setSaved(true);
    } else {
      setErr(true);
    }
  }

  function pick(v: GhostVerdict) {
    setVerdict(v);
    void persist(v, reason);
  }

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] p-3.5">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5 font-mono text-[var(--text-1)]">
            <Phone size={12} className="text-[var(--text-3)]" /> {call.phoneE164 ?? "—"}
          </span>
          <span className="inline-flex items-center gap-1 text-xs text-[var(--text-3)]">
            <Clock size={11} /> {fmtDuration(call.durationSeconds)}
          </span>
          <span className="text-xs text-[var(--text-3)] capitalize">{call.status}</span>
          {call.goalReached && (
            <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
              <Target size={10} /> goal
            </span>
          )}
        </div>
        <div className="flex items-center gap-1.5">
          {saving && <Loader2 size={12} className="animate-spin text-[var(--text-3)]" />}
          {saved && !saving && <Check size={12} className="text-emerald-400" />}
          {err && !saving && <AlertTriangle size={12} className="text-red-400" />}
          <VerdictButton active={verdict === "good"} onClick={() => pick("good")} tone="good" icon={<ThumbsUp size={13} />} label="Good" />
          <VerdictButton active={verdict === "bad"} onClick={() => pick("bad")} tone="bad" icon={<ThumbsDown size={13} />} label="Bad" />
          <VerdictButton active={verdict === "unsure"} onClick={() => pick("unsure")} tone="unsure" icon={<HelpCircle size={13} />} label="Unsure" />
        </div>
      </div>

      <div className="mt-2.5 flex items-center gap-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] hover:text-[var(--text-1)] transition"
        >
          <ChevronDown size={12} className={`transition-transform ${expanded ? "rotate-180" : ""}`} /> Transcript
        </button>
        {call.audioUrl && (
          <audio
            controls
            src={call.audioUrl}
            aria-label={`Call recording for ${call.phoneE164 ?? "this call"}`}
            className="h-7 max-w-[260px]"
            preload="none"
          />
        )}
      </div>

      {expanded && (
        <pre className="mt-2 max-h-64 overflow-y-auto whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-2)] bg-[var(--bg-card)] border border-[var(--border)] rounded-lg p-3">
          {call.transcript || "(no transcript)"}
        </pre>
      )}

      <input
        type="text"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        onBlur={() => { if (verdict) void persist(verdict, reason); }}
        placeholder="Notes (optional), saved automatically"
        maxLength={2000}
        aria-label="Review notes"
        className="mt-2.5 w-full px-3 py-1.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-violet-500"
      />
    </div>
  );
}

function VerdictButton({
  active, onClick, tone, icon, label,
}: { active: boolean; onClick: () => void; tone: "good" | "bad" | "unsure"; icon: React.ReactNode; label: string }) {
  const activeCls =
    tone === "good" ? "border-emerald-500 bg-emerald-500/15 text-emerald-300"
    : tone === "bad" ? "border-red-500 bg-red-500/15 text-red-300"
    : "border-amber-500 bg-amber-500/15 text-amber-300";
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      title={label}
      className={`inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium border transition ${
        active ? activeCls : "border-[var(--border)] bg-[var(--bg-card)] text-[var(--text-3)] hover:text-[var(--text-1)]"
      }`}
    >
      {icon} {label}
    </button>
  );
}
