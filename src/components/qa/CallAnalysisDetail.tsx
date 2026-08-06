"use client";

// CallAnalysisDetail — the QA Prompt Testing detail view. A faithful port of the
// ai-chat-qa-tool's ConversationDetail (collapsible/resizable/fullscreen panels +
// prompt picker + run-and-render), re-themed to Voizo tokens and adapted for a
// CALL: the transcript is the call transcript (with audio playback), Player is the
// customer-number info, Conversation is the campaign + call context, and Run QA
// tests the selected prompt against the transcript via /api/qa-prompt-testing/run.

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, Maximize2, Minimize2, Play } from "lucide-react";
import CallTranscript from "@/components/CallTranscript";
import QaAnalysisResultView from "@/components/qa/QaAnalysisResultView";

// ── Client-side shapes (mirror lib/qaPromptData, kept local to avoid importing a
// server-only module into a client component) ────────────────────────────────
export interface QaPromptClient {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
}
export interface QaCallClient {
  callId: string;
  createdAt: string | null;
  answeredAt: string | null;
  endedAt: string | null;
  durationSeconds: number | null;
  status: string;
  endedReason: string | null;
  hangupCause: string | null;
  goalReached: boolean | null;
  voicemail: boolean | null;
  vapiCallId: string | null;
  transcript: string;
  audioUrl: string | null;
  customer: {
    phone: string | null;
    displayName: string | null;
    outcome: string | null;
    attemptCount: number | null;
    lastAttemptedAt: string | null;
    createdAt: string | null;
  };
  campaign: {
    name: string | null;
    campaignType: string | null;
    agentMode: string | null;
    scriptName: string | null;
    voiceName: string | null;
    assistantName: string | null;
    timezone: string | null;
    status: string | null;
    source: string | null;
    realtime: boolean | null;
    smsEnabled: boolean | null;
    createdAt: string | null;
  };
}

type PanelId = "transcript" | "prompt" | "analysis" | "player" | "conversation";
const PANEL_ORDER: PanelId[] = ["transcript", "prompt", "analysis", "player", "conversation"];
const PANEL_LABEL: Record<PanelId, string> = {
  transcript: "Transcript",
  prompt: "Prompt",
  analysis: "Analysis",
  player: "Customer",
  conversation: "Conversation",
};

// ── formatters ────────────────────────────────────────────────────────────────
function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  try {
    return new Intl.DateTimeFormat("en-US", {
      month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit",
    }).format(new Date(iso));
  } catch {
    return null;
  }
}
function fmtSeconds(s?: number | null): string | null {
  if (s == null) return null;
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
const yesNo = (b: boolean | null | undefined) => (b == null ? null : b ? "Yes" : "No");

// ── small presentational helpers ────────────────────────────────────────────
function InfoRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-2 border-b border-[var(--border)] last:border-0 min-w-0">
      <span className="text-[11px] text-[var(--text-3)] w-28 shrink-0 pt-0.5 leading-snug">{label}</span>
      <span className="text-[11px] text-[var(--text-1)] flex-1 min-w-0 break-words leading-snug">
        {value ?? <span className="text-[var(--text-3)]">—</span>}
      </span>
    </div>
  );
}
function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h4 className="text-[10px] font-bold text-[var(--text-3)] uppercase tracking-widest mb-2 mt-4 first:mt-0">
      {children}
    </h4>
  );
}
function Badge({ tone, children }: { tone: "on" | "off"; children: React.ReactNode }) {
  return (
    <span
      className={`text-[9px] font-bold uppercase px-1.5 py-0.5 rounded-full ${
        tone === "on" ? "bg-emerald-500/15 text-emerald-400" : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
      }`}
    >
      {children}
    </span>
  );
}

function CollapsiblePanel({
  title, onFullscreen, badge, headerAction, children,
}: {
  title: string;
  onFullscreen: () => void;
  badge?: React.ReactNode;
  headerAction?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] flex flex-col overflow-hidden h-full">
      <div className="flex items-center gap-2 px-3 py-2.5 border-b border-[var(--border)] flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-3)] flex-1 truncate">{title}</span>
        {badge}
        {headerAction}
        <button
          onClick={onFullscreen}
          className="p-1 text-[var(--text-3)] hover:text-[var(--text-1)] transition-colors rounded shrink-0"
          title="Expand to full screen"
        >
          <Maximize2 size={13} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-auto p-4 min-h-[180px] lg:min-h-0">{children}</div>
    </div>
  );
}

function FullscreenOverlay({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 bg-[var(--bg-app)] flex flex-col">
      <div className="flex items-center gap-3 px-5 py-3.5 border-b border-[var(--border)] flex-shrink-0">
        <span className="text-[10px] font-bold uppercase tracking-widest text-[var(--text-3)] flex-1">{title}</span>
        <button
          onClick={onClose}
          className="flex items-center gap-1.5 text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium px-3 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition-colors"
        >
          <Minimize2 size={14} />
          <span>Collapse</span>
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5">{children}</div>
    </div>
  );
}

function ResizeHandle({ onMouseDown }: { onMouseDown: (e: React.MouseEvent) => void }) {
  return (
    <div className="hidden lg:flex w-3 shrink-0 cursor-col-resize items-stretch justify-center group select-none" onMouseDown={onMouseDown}>
      <div className="w-0.5 bg-[var(--border-2)] group-hover:bg-primary transition-colors rounded-full" />
    </div>
  );
}

// ── main ──────────────────────────────────────────────────────────────────────
export default function CallAnalysisDetail({
  call,
  prompts,
  initialPromptContent,
  initialPromptTitle,
  initialAnalysis,
}: {
  call: QaCallClient;
  prompts: QaPromptClient[];
  // When replaying a stored Analysis-History run: seed the prompt + result.
  initialPromptContent?: string;
  initialPromptTitle?: string | null;
  initialAnalysis?: string | null;
}) {
  const [shownPanels, setShownPanels] = useState<Set<PanelId>>(new Set(["transcript", "prompt", "analysis"]));
  const [fullscreen, setFullscreen] = useState<PanelId | null>(null);

  const [selectedPromptId, setSelectedPromptId] = useState<string | null>(null);
  const [promptContent, setPromptContent] = useState("");
  const [promptDirty, setPromptDirty] = useState(false);
  const [showPromptPicker, setShowPromptPicker] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  const [analysisText, setAnalysisText] = useState<string | null>(initialAnalysis ?? null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the prompt: a replayed run uses its stored prompt; otherwise pre-load the
  // library's active prompt (or the first).
  useEffect(() => {
    if (initialPromptContent != null) {
      setSelectedPromptId(null);
      setPromptContent(initialPromptContent);
      setPromptDirty(false);
      return;
    }
    if (prompts.length === 0) return;
    const active = prompts.find((p) => p.isActive) ?? prompts[0];
    setSelectedPromptId(active.id);
    setPromptContent(active.content);
    setPromptDirty(false);
  }, [prompts, initialPromptContent]);

  // Panel widths — reset to equal whenever the shown set changes.
  const containerRef = useRef<HTMLDivElement>(null);
  const [panelWidths, setPanelWidths] = useState<Record<string, number>>({});
  useEffect(() => {
    const visible = PANEL_ORDER.filter((id) => shownPanels.has(id));
    if (visible.length === 0) return;
    const equal = 100 / visible.length;
    setPanelWidths(Object.fromEntries(visible.map((id) => [id, equal])));
  }, [shownPanels]);

  const startResize = (leftId: PanelId, rightId: PanelId) => (e: React.MouseEvent) => {
    e.preventDefault();
    let lastX = e.clientX;
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - lastX;
      lastX = ev.clientX;
      const totalW = containerRef.current?.offsetWidth ?? 800;
      const dPct = (dx / totalW) * 100;
      setPanelWidths((prev) => ({
        ...prev,
        [leftId]: Math.max(10, (prev[leftId] ?? 0) + dPct),
        [rightId]: Math.max(10, (prev[rightId] ?? 0) - dPct),
      }));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  };

  // Close the prompt picker on outside click.
  useEffect(() => {
    if (!showPromptPicker) return;
    const handler = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) setShowPromptPicker(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showPromptPicker]);

  const togglePanel = (id: PanelId) =>
    setShownPanels((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const selectedPrompt = useMemo(
    () => prompts.find((p) => p.id === selectedPromptId) ?? null,
    [prompts, selectedPromptId],
  );

  const runQa = useCallback(async () => {
    if (!promptContent.trim()) {
      setError("Select or write a prompt first");
      return;
    }
    setRunning(true);
    setError(null);
    setAnalysisText(null);
    // Make sure the result is visible.
    setShownPanels((prev) => new Set(prev).add("analysis"));
    try {
      const r = await fetch("/api/qa-prompt-testing/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ callId: call.callId, promptContent }),
      });
      const body = (await r.json().catch(() => ({}))) as { analysisText?: string; error?: string };
      if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
      setAnalysisText(body.analysisText ?? "");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Analysis failed");
    } finally {
      setRunning(false);
    }
  }, [promptContent, call.callId]);

  const pickPrompt = (p: QaPromptClient) => {
    setSelectedPromptId(p.id);
    setPromptContent(p.content);
    setPromptDirty(false);
    setShowPromptPicker(false);
    setShownPanels((prev) => new Set(prev).add("prompt"));
  };

  // ── panel content ─────────────────────────────────────────────────────────
  const transcriptContent = (
    <div className="flex flex-col gap-3 h-full">
      {call.audioUrl ? (
        <audio controls preload="none" src={call.audioUrl} className="w-full shrink-0" style={{ height: 38 }}>
          Your browser does not support audio playback.
        </audio>
      ) : (
        <div className="text-[11px] text-[var(--text-3)] shrink-0">No recording for this call.</div>
      )}
      <CallTranscript text={call.transcript} fill />
    </div>
  );

  const promptPanel = (
    <div className="flex flex-col gap-3 h-full">
      {!selectedPrompt && !promptContent ? (
        <div className="text-center py-6">
          <p className="text-sm text-[var(--text-2)] mb-1">No prompt selected.</p>
          <p className="text-xs text-[var(--text-3)]">Use &ldquo;Select prompt&rdquo; above, or add one in the Prompt Library.</p>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-[var(--text-2)]">{selectedPrompt?.title ?? initialPromptTitle ?? "Custom"}</span>
            {promptDirty && <span className="text-[10px] text-amber-400 font-medium">unsaved edits (used for this run)</span>}
          </div>
          <textarea
            value={promptContent}
            onChange={(e) => {
              setPromptContent(e.target.value);
              setPromptDirty(true);
            }}
            className="w-full flex-1 min-h-[220px] lg:min-h-0 border border-[var(--border)] rounded-xl px-3 py-2.5 text-xs font-mono resize-none focus:outline-none focus:border-primary/50 leading-relaxed bg-[var(--bg-elevated)]/40 text-[var(--text-1)]"
            placeholder="Write or paste a QA system prompt…"
          />
        </>
      )}
    </div>
  );

  const analysisPanel = (
    <div>
      {error && <p className="text-[11px] text-red-400 mb-2">{error}</p>}
      {analysisText != null ? (
        <QaAnalysisResultView analysisText={analysisText} conversationDate={call.createdAt} />
      ) : running ? (
        <div className="flex flex-col items-center justify-center py-10 gap-3">
          <div className="w-6 h-6 border-2 border-primary border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-[var(--text-3)]">Running the prompt on this transcript…</p>
        </div>
      ) : (
        <div className="text-center py-8">
          <p className="text-sm text-[var(--text-2)] mb-1">No analysis yet.</p>
          <p className="text-xs text-[var(--text-3)]">Pick a prompt and click Run QA to test it against this call.</p>
        </div>
      )}
    </div>
  );

  const playerPanel = (
    <div>
      <SectionTitle>Customer</SectionTitle>
      <InfoRow label="Name" value={call.customer.displayName} />
      <InfoRow label="Phone" value={call.customer.phone ? <span className="font-mono">{call.customer.phone}</span> : null} />
      <InfoRow label="Outcome" value={call.customer.outcome} />
      <InfoRow label="Attempts" value={call.customer.attemptCount} />
      <InfoRow label="Last attempted" value={fmtDateTime(call.customer.lastAttemptedAt)} />
      <InfoRow label="Added" value={fmtDateTime(call.customer.createdAt)} />
    </div>
  );

  const conversationPanel = (
    <div>
      <SectionTitle>Campaign</SectionTitle>
      <InfoRow label="Name" value={call.campaign.name} />
      <InfoRow label="Type" value={call.campaign.campaignType} />
      <InfoRow label="Agent mode" value={call.campaign.agentMode} />
      <InfoRow label="Script" value={call.campaign.scriptName} />
      <InfoRow label="Agent / voice" value={[call.campaign.assistantName, call.campaign.voiceName].filter(Boolean).join(" · ") || null} />
      <InfoRow label="Timezone" value={call.campaign.timezone} />
      <InfoRow label="Realtime" value={yesNo(call.campaign.realtime)} />
      <InfoRow label="SMS enabled" value={yesNo(call.campaign.smsEnabled)} />
      <InfoRow label="Status" value={call.campaign.status} />

      <SectionTitle>This conversation</SectionTitle>
      <InfoRow label="Occurred" value={fmtDateTime(call.createdAt)} />
      <InfoRow label="Answered" value={fmtDateTime(call.answeredAt)} />
      <InfoRow label="Ended" value={fmtDateTime(call.endedAt)} />
      <InfoRow label="Duration" value={fmtSeconds(call.durationSeconds)} />
      <InfoRow label="Status" value={call.status ? call.status.replace(/_/g, " ") : null} />
      <InfoRow label="Goal reached" value={yesNo(call.goalReached)} />
      <InfoRow label="Voicemail" value={yesNo(call.voicemail)} />
      <InfoRow label="Ended reason" value={call.endedReason} />
      <InfoRow label="Hangup cause" value={call.hangupCause} />
      <InfoRow label="Vapi call id" value={call.vapiCallId ? <span className="font-mono text-[10px]">{call.vapiCallId}</span> : null} />
    </div>
  );

  const PANELS: Record<PanelId, React.ReactNode> = {
    transcript: transcriptContent,
    prompt: promptPanel,
    analysis: analysisPanel,
    player: playerPanel,
    conversation: conversationPanel,
  };

  const promptPickerAction = (
    <div className="relative" ref={pickerRef}>
      <button
        onClick={() => setShowPromptPicker((v) => !v)}
        className="text-[11px] font-medium text-primary hover:opacity-80 px-2 py-1 rounded-lg hover:bg-primary/10 transition flex items-center gap-1"
      >
        {selectedPrompt ? selectedPrompt.title : "Select prompt"}
        <ChevronDown size={13} />
      </button>
      {showPromptPicker && (
        <div className="absolute right-0 top-full mt-1 w-60 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-lg z-20 overflow-hidden">
          {prompts.length === 0 ? (
            <div className="px-4 py-3 text-xs text-[var(--text-3)]">No prompts yet — add one in the Prompt Library.</div>
          ) : (
            <div className="max-h-56 overflow-y-auto divide-y divide-[var(--border)]">
              {prompts.map((p) => (
                <button
                  key={p.id}
                  onClick={() => pickPrompt(p)}
                  className={`w-full text-left px-4 py-2.5 text-xs transition hover:bg-[var(--bg-hover)] ${
                    selectedPromptId === p.id ? "text-primary font-medium bg-primary/10" : "text-[var(--text-1)]"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate">{p.title}</span>
                    {p.isActive && <Badge tone="on">default</Badge>}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {fullscreen && (
        <FullscreenOverlay title={PANEL_LABEL[fullscreen]} onClose={() => setFullscreen(null)}>
          {PANELS[fullscreen]}
        </FullscreenOverlay>
      )}

      <div className="flex flex-col flex-1 min-h-0 overflow-hidden">
        {/* toolbar: panel toggles + Run QA */}
        <div className="flex items-center gap-1.5 pb-3 overflow-x-auto">
          {PANEL_ORDER.map((id) => {
            const on = shownPanels.has(id);
            return (
              <button
                key={id}
                onClick={() => togglePanel(id)}
                className={`text-[11px] font-medium px-2.5 py-1 rounded-full transition whitespace-nowrap shrink-0 ${
                  on ? "bg-[var(--text-1)] text-[var(--bg-app)]" : "bg-[var(--bg-elevated)] text-[var(--text-3)] hover:text-[var(--text-1)]"
                }`}
              >
                {PANEL_LABEL[id]}
              </button>
            );
          })}
          <button
            onClick={runQa}
            disabled={running || !promptContent.trim()}
            className="ml-auto inline-flex items-center gap-1.5 bg-primary hover:opacity-90 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition whitespace-nowrap shrink-0"
            title={!promptContent.trim() ? "Select or write a prompt first" : "Run the prompt on this transcript"}
          >
            {running ? <span className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Play size={14} />}
            <span>{running ? "Running…" : "Run QA"}</span>
          </button>
        </div>

        {/* panels: stacked on mobile, resizable row on desktop */}
        <div className="flex-1 min-h-0 overflow-y-auto lg:overflow-hidden">
          <div ref={containerRef} className="flex flex-col lg:flex-row gap-3 lg:gap-0 h-full">
            {PANEL_ORDER.filter((id) => shownPanels.has(id)).map((id, i, visible) => {
              const widthPct = panelWidths[id] ?? 100 / visible.length;
              const badge =
                id === "analysis" && analysisText != null ? <Badge tone="on">done</Badge> : undefined;
              const headerAction = id === "prompt" ? promptPickerAction : undefined;
              return (
                <React.Fragment key={id}>
                  {i > 0 && <ResizeHandle onMouseDown={startResize(visible[i - 1], id)} />}
                  <div
                    className="min-w-0 flex-shrink-0 lg:flex-shrink lg:flex-grow-0 min-h-[220px] lg:min-h-0 w-full lg:w-auto"
                    style={{ flexBasis: `${widthPct}%` }}
                  >
                    <CollapsiblePanel
                      title={PANEL_LABEL[id]}
                      onFullscreen={() => setFullscreen(id)}
                      badge={badge}
                      headerAction={headerAction}
                    >
                      {PANELS[id]}
                    </CollapsiblePanel>
                  </div>
                </React.Fragment>
              );
            })}
          </div>
        </div>
      </div>
    </>
  );
}
