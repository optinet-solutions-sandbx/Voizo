"use client";

// Per-contact call-detail modal (2026-07-01) — opened by clicking a phone number in the shared
// RecordsTable. Fetches every call ATTEMPT for the contact (/api/dashboard/call-detail) and shows,
// per attempt, an audio player + transcript + an audio download. Reuses the shared CallTranscript
// renderer; audio is the same-origin recordings proxy (reused from /reviews), so the download is a
// plain <a download>. Attempts are CACHED per contact key so the fetch effect never setState-syncs to
// the `record` prop — loading/error/attempts are DERIVED (mirrors RangedRecordsDrawer, which avoids
// react-doctor's state-synced-to-prop error). Modal chrome follows PromptModal (backdrop / Esc / ✕).

import { useEffect, useRef, useState } from "react";
import { X, Download, VolumeX, Target, Phone } from "lucide-react";
import type { CallRecord } from "@/lib/dashboardAnalytics";
import CallTranscript from "@/components/CallTranscript";

interface Attempt {
  callId: string;
  createdAt: string | null;
  durationSeconds: number | null;
  status: string;
  goalReached: boolean | null;
  transcript: string;
  audioUrl: string | null;
}

// The proxied audio URL (/api/recordings/proxy?url=<encoded storage url>) carries the original file
// extension. Recordings are mixed WAV/MP3 (Vapi format flip), so derive it for the download name
// instead of hardcoding .mp3.
function audioExt(proxyUrl: string): string {
  try {
    const raw = new URL(proxyUrl, "http://x").searchParams.get("url") ?? proxyUrl;
    const m = /\.(mp3|wav|m4a|ogg|webm)(?:$|\?)/i.exec(raw);
    return m ? m[1].toLowerCase() : "mp3";
  } catch {
    return "mp3";
  }
}

export default function CallDetailModal({ record, onClose }: { record: CallRecord | null; onClose: () => void }) {
  const numberId = record?.campaignNumberId ?? null;
  const [cache, setCache] = useState<Record<string, Attempt[]>>({});
  const [error, setError] = useState<{ key: string; msg: string } | null>(null);

  const attempts = numberId ? cache[numberId] : undefined;
  const errMsg = error?.key === numberId ? error.msg : null;
  const loading = !!numberId && attempts === undefined && !errMsg;

  // Fetch the contact's attempts once per key (lazy, cache-guarded, AbortController). No synchronous
  // setState — only setCache/setError inside the promise, keyed, so nothing syncs to the prop.
  useEffect(() => {
    if (!numberId || cache[numberId]) return;
    const controller = new AbortController();
    fetch(`/api/dashboard/call-detail?numberId=${encodeURIComponent(numberId)}`, { cache: "no-store", signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j: { attempts: Attempt[] }) => setCache((c) => ({ ...c, [numberId]: j.attempts ?? [] })))
      .catch((e: unknown) => {
        if (e instanceof Error && e.name === "AbortError") return;
        setError({ key: numberId, msg: e instanceof Error ? e.message : "Failed to load call detail" });
      });
    return () => controller.abort();
  }, [numberId, cache]);

  // Close on Escape. The latest onClose lives in a ref, updated in an effect (NOT during render — that
  // trips react-hooks/refs), so the key listener re-binds only when the modal opens/closes, not on a
  // changing callback.
  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; });
  useEffect(() => {
    if (!numberId) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [numberId]);

  if (!record) return null;
  const safeId = (record.phone ?? record.campaignNumberId).replace(/[^0-9A-Za-z]/g, "") || "contact";

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center p-4 sm:p-8 bg-black/60 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-[720px] my-4 max-h-[88vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4 px-5 py-4 border-b border-[var(--border)]">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[var(--text-1)]">
              <Phone size={15} className="shrink-0" />
              <span className="font-semibold font-mono truncate">{record.phone ?? "Contact"}</span>
            </div>
            <p className="text-[11px] text-[var(--text-3)] mt-1">Call recordings &amp; transcripts — one block per attempt.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="px-5 py-4 overflow-y-auto grid gap-4">
          {loading ? (
            <p className="text-xs text-[var(--text-3)] py-6 text-center">Loading call detail…</p>
          ) : errMsg ? (
            <p className="text-xs text-amber-400 font-mono py-6 text-center">{errMsg}</p>
          ) : !attempts || attempts.length === 0 ? (
            <p className="text-xs text-[var(--text-3)] py-6 text-center">No calls recorded for this contact.</p>
          ) : (
            attempts.map((a, i) => (
              <section key={a.callId} className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-2.5">
                  <div className="flex items-center gap-2 text-[11px] font-mono text-[var(--text-3)]">
                    <span className="text-[var(--text-2)] font-semibold">Attempt {i + 1}</span>
                    <span>·</span>
                    <span>{a.status.replace(/_/g, " ") || "—"}</span>
                    {a.durationSeconds != null && (<><span>·</span><span>{a.durationSeconds}s</span></>)}
                  </div>
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-mono px-1.5 py-0.5 rounded-full border ${
                      a.goalReached ? "bg-emerald-500/15 text-emerald-400 border-emerald-500/30" : "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]"
                    }`}
                    title="The system's success flag (goal_reached)"
                  >
                    <Target size={9} /> goal {a.goalReached ? "true" : "false"}
                  </span>
                </div>

                {a.audioUrl ? (
                  <div className="flex items-center gap-2 mb-3">
                    <audio controls preload="none" src={a.audioUrl} className="w-full" style={{ height: 38 }}>
                      Your browser does not support audio playback.
                    </audio>
                    <a
                      href={a.audioUrl}
                      download={`voizo_call_${safeId}_${i + 1}.${audioExt(a.audioUrl)}`}
                      title="Download audio"
                      aria-label="Download audio"
                      className="shrink-0 inline-flex items-center justify-center rounded-lg p-2 text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <Download size={14} />
                    </a>
                  </div>
                ) : (
                  <div className="text-[11px] text-[var(--text-3)] mb-3 inline-flex items-center gap-1.5"><VolumeX size={12} /> no recording for this attempt</div>
                )}

                <CallTranscript text={a.transcript} />
              </section>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
