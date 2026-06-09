"use client";

import { useEffect, useState } from "react";
import {
  AlertTriangle, ChevronDown, Ghost, Loader2, Rocket, ShieldCheck, Upload, X,
} from "lucide-react";
import { defaultCallWindows } from "@/lib/campaignV2Shared";
import type { GhostTier } from "@/lib/ghost/ghostRunData";
import type { GhostUploadFormat } from "@/lib/ghost/ghostUpload";
import { parseJsonBody } from "@/lib/jsonBody";

// Create-run drawer: a collapsed v2-wizard. Operator picks tier + base assistant,
// pastes/uploads a list, then Preview&Scrub (create run + server-side DNC scrub
// summary) → review → Launch. The server RE-SCRUBS at launch and never trusts the
// client, so the launch sends the full parsed list; only the net is dialed.

interface Props {
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}

interface AssistantOpt { id: string; name: string }
interface ScrubSummary { uploaded: number; suppressed: number; net: number; suppressedDnc: number; suppressedRecent: number }

const PLACEHOLDERS: Record<GhostUploadFormat, string> = {
  paste: "+15551112222\n+447700900123\n+639171234567",
  csv: "phone,name,note\n+15551112222,Jo,vip\n+447700900123,Sam,",
  json: '[{ "phone": "+15551112222", "name": "Jo" }, { "phone": "+447700900123" }]',
};

export default function CreateRunDrawer({ open, onClose, onDone }: Props) {
  const [name, setName] = useState("");
  const [tier, setTier] = useState<GhostTier>("live");
  const [baseAssistantId, setBaseAssistantId] = useState("");
  const [assistants, setAssistants] = useState<AssistantOpt[] | null>(null);
  const [assistantsError, setAssistantsError] = useState<string | null>(null);
  const [format, setFormat] = useState<GhostUploadFormat>("paste");
  const [raw, setRaw] = useState("");
  const [timezone, setTimezone] = useState("Asia/Manila");
  const [useStandardWindows, setUseStandardWindows] = useState(true);

  // form → review (after create+scrub) → launching
  const [phase, setPhase] = useState<"form" | "review">("form");
  const [runId, setRunId] = useState<string | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [rejected, setRejected] = useState<string[]>([]);
  const [warning, setWarning] = useState<string | null>(null);
  const [scrub, setScrub] = useState<ScrubSummary | null>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // State resets per open via a `key` on the parent (fresh mount) — no
  // reset-on-prop-change effect (avoids the extra render with stale UI).
  // The useState initial values above ARE the reset defaults.

  // Load base assistants on mount.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetch("/api/vapi/assistants")
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<{ assistants: AssistantOpt[] }>;
      })
      .then((body) => { if (!cancelled) { setAssistants(body.assistants); setAssistantsError(null); } })
      .catch((err: unknown) => { if (!cancelled) setAssistantsError(err instanceof Error ? err.message : "Failed to load assistants"); });
    return () => { cancelled = true; };
  }, [open]);

  const callWindows = tier === "live" && useStandardWindows ? defaultCallWindows() : [];
  const canPreview = !!name.trim() && !!baseAssistantId && !!raw.trim() && !busy &&
    !(tier === "live" && callWindows.length === 0);

  // Step 1: create the run + scrub (preview). Surfaces the compliance summary.
  async function handlePreview() {
    setBusy(true); setError(null);
    try {
      const createRes = await fetch("/api/ghost/runs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), tier, base_assistant_id: baseAssistantId, format, raw, callWindows }),
      });
      if (!createRes.ok) {
        const b = (await parseJsonBody(createRes)) as { error?: string };
        throw new Error(b.error ?? `Create failed (HTTP ${createRes.status})`);
      }
      const created = (await createRes.json()) as { run: { id: string }; targets: string[]; rejected: string[]; warning?: string };
      setRunId(created.run.id);
      setTargets(created.targets);
      setRejected(created.rejected ?? []);
      setWarning(created.warning ?? null);

      const scrubRes = await fetch(`/api/ghost/runs/${created.run.id}/scrub`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: created.targets }),
      });
      if (!scrubRes.ok) {
        const b = (await parseJsonBody(scrubRes)) as { error?: string };
        throw new Error(b.error ?? `Scrub failed (HTTP ${scrubRes.status})`);
      }
      setScrub((await scrubRes.json()) as ScrubSummary);
      setPhase("review");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
    } finally {
      setBusy(false);
    }
  }

  // Step 2: launch — server re-scrubs, leases prod-priority, materializes.
  async function handleLaunch() {
    if (!runId) return;
    setBusy(true); setError(null);
    try {
      const res = await fetch(`/api/ghost/runs/${runId}/launch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ phones: targets, timezone, callWindows, smsEnabled: false }),
      });
      if (!res.ok) {
        const b = (await parseJsonBody(res)) as { error?: string };
        throw new Error(b.error ?? `Launch failed (HTTP ${res.status})`);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Launch failed");
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={busy ? undefined : onClose} />
      <aside
        className="fixed top-0 right-0 bottom-0 z-40 w-full max-w-[560px] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-2xl flex flex-col"
        role="dialog" aria-modal="true" aria-labelledby="ghost-create-title"
      >
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[var(--border)]">
          <div className="min-w-0">
            <h2 id="ghost-create-title" className="text-base font-bold tracking-tight inline-flex items-center gap-2">
              <Ghost size={16} className="text-violet-400" /> New GhostPortal run
            </h2>
            <p className="text-xs text-[var(--text-3)] mt-0.5">
              {phase === "form"
                ? "Upload a list; DNC + consent are enforced server-side at launch."
                : "Review the compliance scrub, then launch into the production pipeline."}
            </p>
          </div>
          <button type="button" onClick={onClose} disabled={busy} title="Close"
            className="p-1 text-[var(--text-3)] hover:text-[var(--text-1)] transition disabled:opacity-50">
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          {phase === "form" ? (
            <>
              <Field label="Run name">
                <input type="text" value={name} onChange={(e) => setName(e.target.value)} maxLength={120}
                  placeholder="e.g. VIP failed-deposit recall · AU"
                  className="w-full px-3 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-violet-500 focus:border-violet-500" />
              </Field>

              <Field label="Tier" hint="Live places real calls; test relaxes the call window only">
                <div className="grid grid-cols-2 gap-2">
                  <TierButton active={tier === "live"} onClick={() => setTier("live")} label="Live" sub="Real calls + window required" tone="amber" />
                  <TierButton active={tier === "test"} onClick={() => setTier("test")} label="Test" sub="is_test · always-open window" tone="slate" />
                </div>
              </Field>

              <Field label="Base assistant" hint="The run clones this agent (inherits its prompt + cost guardrails)">
                <div className="relative">
                  <select aria-label="Base assistant" value={baseAssistantId} onChange={(e) => setBaseAssistantId(e.target.value)} disabled={!assistants}
                    className="w-full appearance-none pl-3 pr-9 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-violet-500 disabled:opacity-60">
                    <option value="">{assistants === null ? "Loading assistants…" : assistants.length === 0 ? "No base assistants found" : "Pick a base assistant…"}</option>
                    {assistants?.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                  <ChevronDown size={13} className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
                </div>
                {assistantsError && <p className="text-[10px] text-red-400 mt-1">{assistantsError}</p>}
              </Field>

              {tier === "live" && (
                <Field label="Schedule (live)" hint="A live run requires a call window">
                  <div className="flex items-center gap-2">
                    <input aria-label="Timezone" type="text" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="Asia/Manila"
                      className="flex-1 px-3 py-2 text-sm font-mono bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-violet-500" />
                  </div>
                  <label className="mt-2 flex items-center gap-2 text-xs text-[var(--text-2)] cursor-pointer">
                    <input type="checkbox" checked={useStandardWindows} onChange={(e) => setUseStandardWindows(e.target.checked)} className="accent-violet-500" />
                    Use standard call windows (daytime daily)
                  </label>
                  {!useStandardWindows && (
                    <p className="mt-1 text-[10px] text-amber-400 inline-flex items-center gap-1">
                      <AlertTriangle size={11} /> No window set — launch will be rejected. Re-enable standard windows for Phase 1.
                    </p>
                  )}
                </Field>
              )}

              <Field label="Upload" hint="Numbers are normalized to E.164 + deduped">
                <div className="flex gap-1.5 mb-2">
                  {(["paste", "csv", "json"] as GhostUploadFormat[]).map((f) => (
                    <button key={f} type="button" onClick={() => setFormat(f)}
                      className={`px-3 py-1 rounded-lg text-xs font-medium border transition ${
                        format === f ? "border-violet-500 bg-violet-500/10 text-violet-200" : "border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-3)] hover:text-[var(--text-1)]"
                      }`}>
                      {f.toUpperCase()}
                    </button>
                  ))}
                </div>
                <textarea aria-label="Upload list" value={raw} onChange={(e) => setRaw(e.target.value)} rows={7} placeholder={PLACEHOLDERS[format]}
                  className="w-full px-3 py-2 text-xs font-mono bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-violet-500 resize-y" />
              </Field>
            </>
          ) : (
            <ReviewPanel scrub={scrub} rejected={rejected} warning={warning} tier={tier} />
          )}
        </div>

        <div className="border-t border-[var(--border)] p-5 flex items-center justify-between gap-3">
          {error ? (
            <span className="text-[11px] text-red-400 inline-flex items-center gap-1 truncate max-w-[260px]" title={error}>
              <AlertTriangle size={11} /> {error}
            </span>
          ) : <span />}
          <div className="flex items-center gap-2 shrink-0">
            {phase === "review" && (
              <button type="button" onClick={() => setPhase("form")} disabled={busy}
                className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition disabled:opacity-50">
                Edit
              </button>
            )}
            {phase === "form" ? (
              <button type="button" onClick={() => void handlePreview()} disabled={!canPreview}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
                {busy ? "Scrubbing…" : "Preview & scrub"}
              </button>
            ) : (
              <button type="button" onClick={() => void handleLaunch()} disabled={busy || (scrub?.net ?? 0) === 0}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition">
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
                {busy ? "Launching…" : `Launch ${scrub?.net ?? 0} call${(scrub?.net ?? 0) === 1 ? "" : "s"}`}
              </button>
            )}
          </div>
        </div>
      </aside>
    </>
  );
}

function ReviewPanel({ scrub, rejected, warning, tier }: { scrub: ScrubSummary | null; rejected: string[]; warning: string | null; tier: GhostTier }) {
  if (!scrub) return null;
  const allSuppressed = scrub.net === 0;
  return (
    <div className="flex flex-col gap-4">
      <div className="px-4 py-4 rounded-xl bg-[var(--bg-app)] border border-[var(--border)]">
        <div className="flex items-center gap-2 mb-3">
          <ShieldCheck size={15} className="text-emerald-400" />
          <span className="text-sm font-semibold text-[var(--text-1)]">Compliance scrub</span>
        </div>
        <div className="grid grid-cols-2 gap-3 text-sm">
          <Stat label="Uploaded" value={scrub.uploaded} tone="text-[var(--text-1)]" />
          <Stat label="Net (will dial)" value={scrub.net} tone={allSuppressed ? "text-red-400" : "text-emerald-300"} big />
          <Stat label="DNC suppressed" value={scrub.suppressedDnc} tone="text-amber-300" />
          <Stat label={tier === "live" ? "Recently dialed" : "Recently dialed (n/a in test)"} value={scrub.suppressedRecent} tone="text-sky-300" />
        </div>
      </div>

      {warning && (
        <div className="px-3 py-2.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/25 text-[11px] text-amber-200 inline-flex items-start gap-2">
          <AlertTriangle size={12} className="mt-0.5 shrink-0 text-amber-400" /> {warning}
        </div>
      )}
      {rejected.length > 0 && (
        <div className="px-3 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)]">
          <p className="text-[11px] font-semibold text-[var(--text-2)] mb-1">{rejected.length} row(s) rejected (unparseable)</p>
          <p className="text-[10px] text-[var(--text-3)] font-mono truncate">{rejected.slice(0, 5).join("  ·  ")}{rejected.length > 5 ? " …" : ""}</p>
        </div>
      )}
      {allSuppressed && (
        <div className="px-3 py-2.5 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-[11px] text-red-300 inline-flex items-center gap-2">
          <AlertTriangle size={12} className="text-red-400" /> Every number is suppressed — nothing to dial. Edit the list.
        </div>
      )}
    </div>
  );
}

function Stat({ label, value, tone, big }: { label: string; value: number; tone: string; big?: boolean }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-3)]">{label}</div>
      <div className={`tabular-nums font-bold ${big ? "text-2xl" : "text-lg"} ${tone}`}>{value.toLocaleString()}</div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-xs font-semibold text-[var(--text-2)]">{label}</label>
        {hint && <span className="text-[10px] text-[var(--text-3)] text-right ml-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function TierButton({ active, onClick, label, sub, tone }: { active: boolean; onClick: () => void; label: string; sub: string; tone: "amber" | "slate" }) {
  const activeCls = tone === "amber" ? "border-amber-500 bg-amber-500/10" : "border-violet-500 bg-violet-500/10";
  return (
    <button type="button" onClick={onClick}
      className={`text-left p-2.5 rounded-xl border-[1.5px] transition ${active ? activeCls : "border-[var(--border)] bg-[var(--bg-app)] hover:border-[var(--border-2)]"}`}>
      <div className="text-sm font-semibold text-[var(--text-1)]">{label}</div>
      <div className="text-[10px] text-[var(--text-3)] mt-0.5">{sub}</div>
    </button>
  );
}
