"use client";

// Per-contact call-detail modal (2026-07-01) — opened by clicking a phone number in the shared
// RecordsTable. Fetches every call ATTEMPT for the contact (/api/dashboard/call-detail) and shows,
// per attempt, an audio player + transcript + an audio download — plus the contact's CAMPAIGN
// CONTEXT strip (campaign/agent/voice, script name for script-mode, collapsible prompt/persona;
// 2026-07-17). Reuses the shared CallTranscript renderer; audio is the same-origin recordings
// proxy (reused from /reviews), so the download is a plain <a download>. The payload (attempts +
// campaign) is CACHED per contact key so the fetch effect never setState-syncs to the `record`
// prop — loading/error/attempts are DERIVED (mirrors RangedRecordsDrawer, which avoids
// react-doctor's state-synced-to-prop error). Modal chrome follows PromptModal (backdrop / Esc / ✕).

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { X, Download, VolumeX, Phone, ArrowUpRight, MessageSquare } from "lucide-react";
import type { CallRecord } from "@/lib/dashboardAnalytics";
import type { PlayerRun } from "./playerGrouping";
import CallTranscript from "@/components/CallTranscript";
import Hint from "@/components/Hint";
import { BlockSkeleton } from "./loadingSkeletons";
import GlobalExport from "./GlobalExport";

interface Attempt {
  callId: string;
  createdAt: string | null;
  durationSeconds: number | null;
  status: string;
  goalReached: boolean | null;
  transcript: string;
  audioUrl: string | null;
}

// Campaign context (additive, 2026-07-17) — which campaign/agent/voice made these
// calls, script name for script-mode campaigns, and the campaign prompt (persona in
// script mode). Mirrors lib/campaignContext.CampaignContext.
interface CampaignInfo {
  name: string;
  agentName: string | null;
  mode: string;
  scriptName: string | null;
  voiceName: string | null;
  prompt: string | null;
}

interface DetailPayload {
  attempts: Attempt[];
  campaign: CampaignInfo | null;
  /** Imported player name (raw, as Customer.io gave it) — greet-by-name Ramp 1. */
  contactName: string | null;
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

export default function CallDetailModal({ record, runs, playerName, onOpenRun, onClose }: {
  /** The contact to open on. Only the number id and phone are read. */
  record: Pick<CallRecord, "campaignNumberId" | "phone"> | null;
  /** From the player search (2026-09-03): every run this player sat in. Rendered as a card above
   *  the attempts; picking one switches the attempts below to that run, and each has a way into
   *  its campaign. Omitted from the records table, where a click already names one run. */
  runs?: PlayerRun[];
  playerName?: string | null;
  /** Take the operator to that run where they already are (Campaign Performance) instead of the
   *  Campaigns page. When absent, the run links to its campaign page. */
  onOpenRun?: (campaignId: string) => void;
  onClose: () => void;
}) {
  // Which run's attempts are shown: the picked one, else the record's own. A new record resets it.
  const [picked, setPicked] = useState<string | null>(null);
  const [prevRecordKey, setPrevRecordKey] = useState(record?.campaignNumberId ?? null);
  if (prevRecordKey !== (record?.campaignNumberId ?? null)) {
    setPrevRecordKey(record?.campaignNumberId ?? null);
    setPicked(null);
  }
  const numberId = picked ?? record?.campaignNumberId ?? null;
  const [cache, setCache] = useState<Record<string, DetailPayload>>({});
  const [error, setError] = useState<{ key: string; msg: string } | null>(null);

  const entry = numberId ? cache[numberId] : undefined;
  const attempts = entry?.attempts;
  const campaign = entry?.campaign ?? null;
  const contactName = entry?.contactName ?? null;
  const errMsg = error?.key === numberId ? error.msg : null;
  const loading = !!numberId && attempts === undefined && !errMsg;

  // Fetch the contact's attempts + campaign context once per key (lazy, cache-guarded,
  // AbortController). No synchronous setState — only setCache/setError inside the promise,
  // keyed, so nothing syncs to the prop.
  useEffect(() => {
    if (!numberId || cache[numberId]) return;
    const controller = new AbortController();
    fetch(`/api/dashboard/call-detail?numberId=${encodeURIComponent(numberId)}`, { cache: "no-store", signal: controller.signal })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((j: { attempts: Attempt[]; campaign: CampaignInfo | null; contactName: string | null }) =>
        setCache((c) => ({
          ...c,
          [numberId]: { attempts: j.attempts ?? [], campaign: j.campaign ?? null, contactName: j.contactName ?? null },
        })))
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
            <div className="flex items-center gap-2 text-[var(--text-1)] min-w-0">
              <Phone size={15} className="shrink-0" />
              <span className="font-semibold font-mono truncate">{record.phone ?? "Contact"}</span>
              {(playerName ?? contactName) && (
                <span className="text-xs text-[var(--text-2)] truncate" title={playerName ?? contactName ?? undefined}>
                  · {playerName ?? contactName}
                </span>
              )}
            </div>
            <p className="text-[11px] text-[var(--text-3)] mt-1">Call recordings &amp; transcripts, one block per attempt.</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {/* Single-player export (Jasiel 2026-09-03): this number across every run it sat in,
                through the records export engine (CSV with transcripts, audio zip, transcripts). */}
            {runs && runs.length > 0 && record.phone && (
              <GlobalExport
                compact
                query={new URLSearchParams({
                  // the span of the player's runs, not all time: the route reads every call in the
                  // window before narrowing to the number, and all time timed out on Vercel
                  from: runs.map((r) => r.dateIso).filter((d): d is string => !!d).sort()[0] ?? "2026-04-01",
                  to: new Date().toISOString().slice(0, 10),
                  campaigns: [...new Set(runs.map((r) => r.campaignId))].join(","),
                  phone: record.phone.replace(/[^\d+]/g, ""),
                  offset: "0",
                  limit: "all",
                }).toString()}
                fileBase={`player-${safeId}`}
              />
            )}
            <button type="button" onClick={onClose} aria-label="Close" className="text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors shrink-0">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="px-5 py-4 overflow-y-auto grid gap-4">
          {runs && runs.length > 0 && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)]/50 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)] px-1 mb-1.5">
                {runs.length === 1 ? "1 run" : `${runs.length} runs`}
              </div>
              <div className="grid gap-1">
                {runs.map((r) => {
                  const on = r.numberId === numberId;
                  return (
                    <div key={r.numberId} className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 ${on ? "border-primary/50 bg-primary/10" : "border-transparent hover:bg-[var(--bg-hover)]"}`}>
                      <button type="button" onClick={() => setPicked(r.numberId)} aria-pressed={on} className="flex-1 min-w-0 flex items-center gap-2 text-left">
                        <span className="text-[12.5px] text-[var(--text-1)] truncate">{r.label}</span>
                        {r.dateIso && <span className="font-mono text-[11px] text-[var(--text-3)] shrink-0">{r.dateIso}</span>}
                        <span className="ml-auto shrink-0 flex items-center gap-2 text-[11px] font-mono text-[var(--text-3)]">
                          <span>{r.attemptCount === 0 ? "never called" : `${r.attemptCount} ${r.attemptCount === 1 ? "attempt" : "attempts"}`}</span>
                          {r.smsSent && <MessageSquare size={11} aria-label="SMS sent" />}
                          <span className="px-2 py-0.5 rounded-full border border-[var(--border)] text-[var(--text-2)] font-sans">{r.outcomeLabel}</span>
                        </span>
                      </button>
                      {onOpenRun ? (
                        <button
                          type="button"
                          onClick={() => onOpenRun(r.campaignId)}
                          title="Show this run in the table below"
                          aria-label={`Show ${r.label} in the table`}
                          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] hover:text-primary transition-colors"
                        >
                          Show in table <ArrowUpRight size={12} />
                        </button>
                      ) : (
                        <Link
                          href={`/campaigns/v2/${r.campaignId}`}
                          title="Open this campaign"
                          aria-label={`Open the campaign ${r.label}`}
                          className="shrink-0 inline-flex items-center gap-1 text-[11px] text-[var(--text-3)] hover:text-primary transition-colors"
                        >
                          Open <ArrowUpRight size={12} />
                        </Link>
                      )}
                    </div>
                  );
                })}
              </div>
            </section>
          )}
          {campaign && (
            <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-app)] p-4">
              <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px] font-mono min-w-0">
                <span className="text-[var(--text-3)]">Campaign</span>
                <span className="text-[var(--text-2)] truncate" title={campaign.name}>{campaign.name}</span>
                {campaign.agentName && (
                  <>
                    <span className="text-[var(--text-3)]">Agent</span>
                    <span className="text-[var(--text-2)] truncate" title={campaign.agentName}>{campaign.agentName}</span>
                  </>
                )}
                {campaign.mode === "script" && (
                  <>
                    <span className="text-[var(--text-3)]">Script</span>
                    <span className="text-[var(--text-2)] truncate" title={campaign.scriptName ?? undefined}>
                      {campaign.scriptName ?? "—"}
                    </span>
                  </>
                )}
                {campaign.voiceName && (
                  <>
                    <span className="text-[var(--text-3)]">Voice</span>
                    <span className="text-[var(--text-2)]">{campaign.voiceName}</span>
                  </>
                )}
              </div>
              {campaign.prompt && (
                <details className="mt-2.5">
                  <summary className="cursor-pointer select-none text-[11px] text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors">
                    {campaign.mode === "script" ? "View persona" : "View campaign prompt"}
                  </summary>
                  {campaign.mode === "script" && (
                    <p className="text-[10px] text-[var(--text-3)] mt-1.5">
                      The script drives what the agent says on the call. This persona is who the agent presents as.
                    </p>
                  )}
                  <pre className="mt-1.5 text-[11px] text-[var(--text-2)] whitespace-pre-wrap font-mono max-h-64 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--bg-card)] p-3">
                    {campaign.prompt}
                  </pre>
                </details>
              )}
            </section>
          )}
          {loading ? (
            <BlockSkeleton lines={5} />
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
                  {/* NO success flag on an attempt (Jasiel 2026-09-04). It read "goal true" /
                      "goal false" with the DB column name in the tooltip, and operators could not
                      act on it. Renaming it to "Positive response" was worse: under the older
                      mandate the offer SMS went to everyone, voicemails included, so operators
                      found transcripts where the player disagreed and the record still claimed the
                      goal. A plain-English label there would assert agreement the transcript
                      contradicts. The transcript below is the evidence; it needs no verdict on top
                      of it. Reviews keeps the technical flag. */}
                </div>

                {a.audioUrl ? (
                  <div className="flex items-center gap-2 mb-3">
                    <audio controls preload="none" src={a.audioUrl} className="w-full" style={{ height: 38 }}>
                      Your browser does not support audio playback.
                    </audio>
                    <Hint content="Download audio">
                      <a
                        href={a.audioUrl}
                        download={`voizo_call_${safeId}_${i + 1}.${audioExt(a.audioUrl)}`}
                        aria-label="Download audio"
                        className="shrink-0 inline-flex items-center justify-center rounded-lg p-2 text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors"
                      >
                        <Download size={14} />
                      </a>
                    </Hint>
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
