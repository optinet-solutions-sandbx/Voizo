// src/app/audience/components/CreateSegmentDrawer.tsx
//
// Slice 3 — Create Segment slide-over.
//
// Right-side drawer (520px) with a live-preview row that hits
// POST /api/audience/segments {commit:false} debounced 400ms after any
// field change. The actual create is a second POST with commit:true.
//
// Sensitive outcomes (declined_offer / not_interested / sent_sms) are hidden
// behind a toggle. Saving with any sensitive outcome ticked triggers a
// friction modal (per CLAUDE.md non-negotiable #4: cost-aware UX).

"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ChevronDown, Loader2, Megaphone, Phone,
  ShieldCheck, Sparkles, X,
} from "lucide-react";
import { fetchCampaignsV2 } from "@/lib/campaignV2Data";

export interface SegmentRow {
  id: string;
  name: string;
  source_campaign_id: string | null;
  source_campaign_name: string | null;
  outcomes_included: string[];
  dnc_scrubbed: boolean;
  recent_window_days: number;
  total_count: number;
  scrubbed_count: number;
  created_at: string;
  created_by: string | null;
}

/**
 * Prefill payload from the SuggestedSegmentsPanel "Carve segment" click.
 * The drawer opens with source-campaign pre-selected, name pre-filled, and
 * outcomes pre-ticked — operator can still tweak everything before saving.
 *
 * Passing `null` (or omitting) restores the default empty-form behavior so
 * the existing "Create segment" button still works unchanged.
 */
export interface CreateSegmentPrefill {
  sourceCampaignId: string;
  name: string;
  outcomes: string[];
}

interface Props {
  open: boolean;
  onClose: () => void;
  onCreated: (segment: SegmentRow) => void;
  prefill?: CreateSegmentPrefill | null;
}

interface CampaignOption {
  id: string;
  name: string;
  status: string;
}

interface OutcomeTile {
  key: string;
  label: string;
  description: string;
  tone: "safe" | "sensitive";
}

interface PreviewShape {
  matched: number;
  scrubbed_dnc: number;
  scrubbed_recent: number;
  net: number;
}

const SAFE_OUTCOMES: OutcomeTile[] = [
  { key: "pending",                    label: "Pending",              description: "Queued but never dialed yet",         tone: "safe" },
  { key: "pending_retry",              label: "Pending retry",        description: "Between attempts",                    tone: "safe" },
  { key: "unreached",                  label: "Unreached",            description: "Max attempts hit, no answer",         tone: "safe" },
  { key: "recently_called_elsewhere",  label: "Recently called",      description: "Deferred from another campaign",      tone: "safe" },
  { key: "removed_from_segment",       label: "Removed from segment", description: "Segment changed mid-dial",            tone: "safe" },
];

const SENSITIVE_OUTCOMES: OutcomeTile[] = [
  { key: "declined_offer", label: "Declined offer", description: "Explicit no on the bonus",          tone: "sensitive" },
  { key: "not_interested", label: "Not interested", description: "Explicit no overall",                tone: "sensitive" },
  { key: "sent_sms",       label: "Sent SMS",       description: "SMS delivered, no conversion yet",   tone: "sensitive" },
];

const SENSITIVE_SET: ReadonlySet<string> = new Set(SENSITIVE_OUTCOMES.map((o) => o.key));
const SAFE_KEYS: ReadonlyArray<string> = SAFE_OUTCOMES.map((o) => o.key);

const PREVIEW_DEBOUNCE_MS = 400;

export default function CreateSegmentDrawer({ open, onClose, onCreated, prefill }: Props) {
  const [name, setName] = useState("");
  const [sourceCampaignId, setSourceCampaignId] = useState("");
  const [campaigns, setCampaigns] = useState<CampaignOption[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);

  const [includeDeclined, setIncludeDeclined] = useState(false);
  const [outcomes, setOutcomes] = useState<Set<string>>(() => new Set(SAFE_KEYS));
  const [dncScrubbed, setDncScrubbed] = useState(true);
  const [recentWindowDays, setRecentWindowDays] = useState(7);

  const [preview, setPreview] = useState<PreviewShape | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [frictionOpen, setFrictionOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  // Reset form when drawer opens OR when prefill identity changes. If a
  // prefill was passed (from the "Carve segment" button on
  // SuggestedSegmentsPanel), apply it to the form initial state — operator
  // can still tweak everything before saving. Otherwise fall back to the
  // empty defaults (manual-flow behavior).
  //
  // Why prefill is in deps (audit 2026-05-22 HIGH H1): if the operator
  // clicks Carve A then Carve B while the drawer is still open, the parent's
  // `createPrefill` state updates to B. Without prefill in deps, the form
  // would stay showing A (stale). Parent only calls setCreatePrefill on
  // intentional transitions (carve / close / created), so prefill identity
  // never changes spuriously — including it in deps doesn't reset on
  // unrelated re-renders.
  useEffect(() => {
    if (!open) return;
    if (prefill) {
      setName(prefill.name);
      setSourceCampaignId(prefill.sourceCampaignId);
      setOutcomes(new Set(prefill.outcomes));
    } else {
      setName("");
      setSourceCampaignId("");
      setOutcomes(new Set(SAFE_KEYS));
    }
    setIncludeDeclined(false);
    setDncScrubbed(true);
    setRecentWindowDays(7);
    setPreview(null);
    setPreviewError(null);
    setFrictionOpen(false);
    setSaving(false);
    setSaveError(null);
  }, [open, prefill]);

  // Load campaigns once per open (filtered to completed + paused per the plan).
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    fetchCampaignsV2()
      .then((all) => {
        if (cancelled) return;
        // Source statuses: completed/paused are the primary cases. 'inactive'
        // (ejected) and 'archived' (terminal) are also included because the
        // dialer is off in both — no race risk. Matches the get_audience_suggestions
        // RPC filter for parity: any campaign the RPC can surface must also be
        // selectable in the manual flow (audit 2026-05-22 BLOCKER B1).
        // 'running' is intentionally excluded — the API rejects with 409 anyway
        // (yesterday's audit H3) and we don't want operators picking a still-
        // dialing campaign by mistake.
        const filtered = (all as Array<{ id: string; name: string; status: string }>)
          .filter((c) =>
            c.status === "completed" ||
            c.status === "paused" ||
            c.status === "inactive" ||
            c.status === "archived",
          )
          .map((c) => ({ id: c.id, name: c.name, status: c.status }));
        setCampaigns(filtered);
        setCampaignsError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCampaignsError(err instanceof Error ? err.message : "Failed to load campaigns");
      });
    return () => { cancelled = true; };
  }, [open]);

  function toggleOutcome(key: string) {
    setOutcomes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Turning off "Include declined" clears any sensitive selections — otherwise
  // an operator could untick the toggle but still have sensitive outcomes
  // hidden-but-selected, defeating the friction gate.
  function onIncludeDeclinedChange(next: boolean) {
    setIncludeDeclined(next);
    if (!next) {
      setOutcomes((prev) => {
        const filtered = new Set(prev);
        for (const k of SENSITIVE_SET) filtered.delete(k);
        return filtered;
      });
    }
  }

  const canPreview = !!sourceCampaignId && outcomes.size > 0;
  const hasSensitive = useMemo(() => {
    for (const k of SENSITIVE_SET) if (outcomes.has(k)) return true;
    return false;
  }, [outcomes]);

  // Debounced preview — cancels in-flight if the operator keeps typing.
  const previewAbortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) return;
    if (!canPreview) {
      setPreview(null);
      setPreviewError(null);
      setPreviewLoading(false);
      return;
    }
    const t = setTimeout(() => {
      previewAbortRef.current?.abort();
      const ctrl = new AbortController();
      previewAbortRef.current = ctrl;
      setPreviewLoading(true);
      fetch("/api/audience/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          source_campaign_id: sourceCampaignId,
          outcomes_included: Array.from(outcomes),
          dnc_scrubbed: dncScrubbed,
          recent_window_days: recentWindowDays,
          commit: false,
        }),
      })
        .then(async (r) => {
          if (!r.ok) {
            const body = await r.json().catch(() => ({} as { error?: string }));
            throw new Error(body.error ?? `HTTP ${r.status}`);
          }
          return r.json() as Promise<{ preview: PreviewShape }>;
        })
        .then((body) => {
          setPreview(body.preview);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (err instanceof DOMException && err.name === "AbortError") return;
          setPreviewError(err instanceof Error ? err.message : "Preview failed");
          setPreview(null);
        })
        .finally(() => setPreviewLoading(false));
    }, PREVIEW_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [open, canPreview, sourceCampaignId, outcomes, dncScrubbed, recentWindowDays]);

  const canSubmit =
    !!name.trim() &&
    !!sourceCampaignId &&
    outcomes.size > 0 &&
    (preview?.net ?? 0) > 0 &&
    !saving;

  function handleSaveClicked() {
    if (hasSensitive) {
      setFrictionOpen(true);
      return;
    }
    void commitSave();
  }

  const commitSave = useCallback(async () => {
    setFrictionOpen(false);
    setSaving(true);
    setSaveError(null);
    try {
      const r = await fetch("/api/audience/segments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          source_campaign_id: sourceCampaignId,
          outcomes_included: Array.from(outcomes),
          dnc_scrubbed: dncScrubbed,
          recent_window_days: recentWindowDays,
          commit: true,
        }),
      });
      if (!r.ok) {
        const body = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${r.status}`);
      }
      const body = (await r.json()) as { segment: SegmentRow };
      onCreated(body.segment);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Failed to save segment");
    } finally {
      setSaving(false);
    }
  }, [name, sourceCampaignId, outcomes, dncScrubbed, recentWindowDays, onCreated]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm" onClick={onClose} />

      {/* Drawer */}
      <aside
        className="fixed top-0 right-0 bottom-0 z-40 w-full max-w-[520px] bg-[var(--bg-card)] border-l border-[var(--border)] shadow-2xl flex flex-col"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-seg-title"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b border-[var(--border)]">
          <div className="min-w-0">
            <h2 id="create-seg-title" className="text-base font-bold tracking-tight inline-flex items-center gap-2">
              <Sparkles size={16} className="text-amber-400" /> Create segment
            </h2>
            <p className="text-xs text-[var(--text-3)] mt-0.5">
              Carve outcome-tagged contacts from a finished campaign into a reusable list.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            title="Close"
            className="p-1 text-[var(--text-3)] hover:text-[var(--text-1)] transition disabled:opacity-50"
          >
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-4">
          <FormRow label="Segment name">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. AU unreached Q3 · recycle"
              maxLength={120}
              className="w-full px-3 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
            />
          </FormRow>

          <FormRow label="Source campaign">
            <SourceCampaignSelect
              value={sourceCampaignId}
              onChange={setSourceCampaignId}
              campaigns={campaigns}
              error={campaignsError}
            />
          </FormRow>

          <FormRow label="Recyclable outcomes" hint="Safe to retry on a later schedule">
            <div className="grid grid-cols-2 gap-2">
              {SAFE_OUTCOMES.map((o) => (
                <OutcomeTileButton
                  key={o.key}
                  tile={o}
                  active={outcomes.has(o.key)}
                  onToggle={() => toggleOutcome(o.key)}
                />
              ))}
            </div>
            {(outcomes.has("pending") || outcomes.has("pending_retry")) && (
              <p className="mt-2 text-[10px] text-[var(--text-3)] leading-snug">
                Pending and pending-retry phones get soft-marked in the source as
                <span className="text-[var(--text-2)] font-mono"> removed_from_segment</span> on save — the source
                campaign can&apos;t double-dial them if you resume it.
              </p>
            )}
          </FormRow>

          <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-amber-500/[0.06] border border-amber-500/25">
            <div className="flex items-start gap-2 min-w-0">
              <AlertTriangle size={13} className="text-amber-400 mt-0.5 shrink-0" />
              <div className="min-w-0">
                <p className="text-xs font-semibold text-amber-200">Include declined contacts</p>
                <p className="text-[11px] text-[var(--text-3)] mt-0.5 leading-snug">
                  Reveal outcomes where contacts explicitly said no. Re-dialing these may cost without revenue.
                </p>
              </div>
            </div>
            <ToggleSwitch checked={includeDeclined} onChange={onIncludeDeclinedChange} />
          </div>

          {includeDeclined && (
            <div className="grid grid-cols-3 gap-2">
              {SENSITIVE_OUTCOMES.map((o) => (
                <OutcomeTileButton
                  key={o.key}
                  tile={o}
                  active={outcomes.has(o.key)}
                  onToggle={() => toggleOutcome(o.key)}
                />
              ))}
            </div>
          )}

          <FormRow label="Scrubbing">
            <div className="flex flex-col gap-2.5">
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)]">
                <div className="flex items-center gap-2 min-w-0">
                  <ShieldCheck size={13} className="text-emerald-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--text-1)]">Scrub DNC list</p>
                    <p className="text-[10px] text-[var(--text-3)] mt-0.5">Remove phones on suppression_list or do_not_call</p>
                  </div>
                </div>
                <ToggleSwitch checked={dncScrubbed} onChange={setDncScrubbed} />
              </div>
              <div className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-[var(--bg-app)] border border-[var(--border)]">
                <div className="flex items-center gap-2 min-w-0">
                  <Phone size={13} className="text-sky-400 shrink-0" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-[var(--text-1)]">Exclude recently dialed</p>
                    <p className="text-[10px] text-[var(--text-3)] mt-0.5">Phones any campaign contacted in the last N days</p>
                  </div>
                </div>
                <div className="flex items-center gap-1.5 shrink-0">
                  <input
                    type="number"
                    min={0}
                    max={365}
                    value={recentWindowDays}
                    onChange={(e) =>
                      setRecentWindowDays(Math.max(0, Math.min(365, parseInt(e.target.value, 10) || 0)))
                    }
                    className="w-14 px-2 py-1 text-xs font-mono text-right bg-[var(--bg-card)] border border-[var(--border)] rounded text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
                  />
                  <span className="text-[11px] text-[var(--text-3)]">days</span>
                </div>
              </div>
            </div>
          </FormRow>

          <FormRow label="Preview">
            <PreviewBox loading={previewLoading} preview={preview} error={previewError} canPreview={canPreview} />
          </FormRow>
        </div>

        {/* Footer */}
        <div className="border-t border-[var(--border)] p-5 flex items-center justify-between gap-3">
          {saveError ? (
            <span className="text-[11px] text-red-400 inline-flex items-center gap-1 truncate">
              <AlertTriangle size={11} /> {saveError}
            </span>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSaveClicked}
              disabled={!canSubmit}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition"
            >
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
              {saving ? "Saving…" : "Save segment"}
            </button>
          </div>
        </div>
      </aside>

      {/* Friction modal (centered, matches Resume/Eject style) */}
      {frictionOpen && (
        <FrictionModal onCancel={() => setFrictionOpen(false)} onContinue={() => void commitSave()} />
      )}
    </>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────

function FormRow({
  label, hint, children,
}: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="flex items-baseline justify-between mb-1.5">
        <label className="text-xs font-semibold text-[var(--text-2)]">{label}</label>
        {hint && <span className="text-[10px] text-[var(--text-3)]">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function OutcomeTileButton({
  tile, active, onToggle,
}: { tile: OutcomeTile; active: boolean; onToggle: () => void }) {
  const activeClass =
    tile.tone === "sensitive"
      ? "border-violet-500 bg-violet-500/[0.10]"
      : "border-blue-500 bg-blue-500/[0.08]";
  const checkClass =
    tile.tone === "sensitive"
      ? "bg-violet-500 border-violet-500"
      : "bg-blue-500 border-blue-500";
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`text-left p-2.5 rounded-xl border-[1.5px] transition ${
        active ? activeClass : "border-[var(--border)] bg-[var(--bg-app)] hover:border-[var(--border-2)]"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <div
          className={`w-3 h-3 rounded border ${active ? checkClass : "border-[var(--border-2)]"}`}
        />
        <span className="text-[12px] font-semibold text-[var(--text-1)]">{tile.label}</span>
      </div>
      <p className="text-[10px] text-[var(--text-3)] leading-snug">{tile.description}</p>
    </button>
  );
}

function ToggleSwitch({
  checked, onChange,
}: { checked: boolean; onChange: (next: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className={`relative w-10 h-[22px] rounded-full transition ${
        checked ? "bg-blue-500" : "bg-[var(--bg-elevated)] border border-[var(--border)]"
      }`}
    >
      <span
        className={`absolute top-[3px] left-[3px] w-4 h-4 rounded-full bg-white transition-transform ${
          checked ? "translate-x-[18px]" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function SourceCampaignSelect({
  value, onChange, campaigns, error,
}: {
  value: string;
  onChange: (v: string) => void;
  campaigns: CampaignOption[] | null;
  error: string | null;
}) {
  const selected = campaigns?.find((c) => c.id === value);
  return (
    <div>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={!campaigns}
          className="w-full appearance-none pl-9 pr-9 py-2 text-sm bg-[var(--bg-app)] border border-[var(--border)] rounded-lg text-[var(--text-1)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 disabled:opacity-60"
        >
          <option value="">
            {campaigns === null
              ? "Loading campaigns…"
              : campaigns.length === 0
                ? "No completed or paused campaigns"
                : "Pick a campaign…"}
          </option>
          {campaigns?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} · {c.status}
            </option>
          ))}
        </select>
        <Megaphone
          size={13}
          className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none"
        />
        <ChevronDown
          size={13}
          className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none"
        />
      </div>
      {error && <p className="text-[10px] text-red-400 mt-1">{error}</p>}
      {selected && (
        <p className="text-[10px] text-[var(--text-3)] mt-1">
          <span className="capitalize">{selected.status}</span> campaign · outcomes will be carved from its current state
        </p>
      )}
    </div>
  );
}

function PreviewBox({
  loading, preview, error, canPreview,
}: {
  loading: boolean;
  preview: PreviewShape | null;
  error: string | null;
  canPreview: boolean;
}) {
  if (!canPreview) {
    return (
      <div className="px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-dashed border-[var(--border)] text-xs text-[var(--text-3)]">
        Pick a source campaign + at least one outcome to see a count preview.
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-3 rounded-xl bg-red-500/[0.08] border border-red-500/30 text-xs text-red-300 inline-flex items-center gap-2">
        <AlertTriangle size={13} className="text-red-400" /> {error}
      </div>
    );
  }
  if (loading || !preview) {
    return (
      <div className="px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)] text-xs text-[var(--text-3)] inline-flex items-center gap-2">
        <Loader2 size={13} className="animate-spin" /> Counting matches…
      </div>
    );
  }
  return (
    <div className="px-4 py-3 rounded-xl bg-[var(--bg-app)] border border-[var(--border)]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[11px] font-mono">
        <span>
          Matched{" "}
          <span className="text-[var(--text-1)] font-semibold tabular-nums">{preview.matched.toLocaleString()}</span>
        </span>
        <span className="text-[var(--text-3)]">·</span>
        <span>
          DNC scrubbed{" "}
          <span className="text-emerald-400 font-semibold tabular-nums">
            {preview.scrubbed_dnc.toLocaleString()}
          </span>
        </span>
        <span className="text-[var(--text-3)]">·</span>
        <span>
          Recent excluded{" "}
          <span className="text-sky-400 font-semibold tabular-nums">
            {preview.scrubbed_recent.toLocaleString()}
          </span>
        </span>
        <span className="text-[var(--text-3)]">·</span>
        <span>
          Net{" "}
          <span className="text-blue-400 font-bold text-base tabular-nums">{preview.net.toLocaleString()}</span>
        </span>
      </div>
    </div>
  );
}

function FrictionModal({
  onCancel, onContinue,
}: { onCancel: () => void; onContinue: () => void }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="friction-title"
      onClick={onCancel}
    >
      <div
        className="bg-[var(--bg-card)] border border-amber-500/30 rounded-2xl shadow-2xl max-w-md w-full p-6"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 mb-3">
          <div className="w-10 h-10 rounded-2xl bg-amber-500/15 border border-amber-500/30 flex items-center justify-center shrink-0">
            <AlertTriangle size={18} className="text-amber-400" />
          </div>
          <h3 id="friction-title" className="text-base font-semibold text-[var(--text-1)]">
            Include declined contacts?
          </h3>
        </div>
        <p className="text-sm text-[var(--text-2)] mb-2 leading-relaxed">
          You&apos;re including contacts who explicitly said no or weren&apos;t interested.
        </p>
        <p className="text-xs text-[var(--text-3)] mb-5 leading-relaxed">
          Re-dialing these may generate complaints and dial cost with little revenue. Make sure your script genuinely
          addresses their original objection.
        </p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2 rounded-xl border border-[var(--border)] bg-[var(--bg-app)] text-[var(--text-2)] hover:text-[var(--text-1)] text-sm font-medium transition"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onContinue}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-600 hover:bg-amber-500 text-white text-sm font-medium transition"
          >
            <Sparkles size={14} /> Save anyway
          </button>
        </div>
      </div>
    </div>
  );
}
