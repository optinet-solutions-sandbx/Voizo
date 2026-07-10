"use client";

// The prompt-versions viewer: version tabs (if >1) + model/sha meta + the system prompt text +
// a Copy button. Extracted from PromptModal (2026-06-16) so the rich CampaignDetailsModal can show
// the same "Val's proposal" without duplicating the fetch/render. Data: /api/dashboard/campaigns/[id]/prompt.

import { useCallback, useEffect, useState } from "react";
import { Copy, Check } from "lucide-react";

interface Version {
  id: string;
  system_prompt: string;
  prompt_sha256: string;
  model_meta: Record<string, unknown> | null;
  voice_meta: Record<string, unknown> | null;
  created_at: string | null;
  asCreated?: boolean; // the clone's prompt stored on the campaign at create time (no version snapshot)
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${hh}:${mm}`;
}

export default function PromptVersionsPanel({ campaignId }: { campaignId: string }) {
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [idx, setIdx] = useState(0);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(`/api/dashboard/campaigns/${campaignId}/prompt`, { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const b = (await r.json()) as { versions: Version[] };
      setVersions(b.versions);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  const current = versions && versions.length > 0 ? versions[Math.min(idx, versions.length - 1)] : null;
  const modelName =
    current?.model_meta && typeof current.model_meta === "object"
      ? (current.model_meta as { model?: string }).model
      : undefined;

  const copy = async () => {
    if (!current) return;
    try {
      await navigator.clipboard.writeText(current.system_prompt);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  };

  if (error) return <p className="text-amber-400 text-sm font-mono">{error}</p>;
  if (!versions) return <p className="text-[var(--text-3)] text-sm">Loading prompt…</p>;
  if (versions.length === 0 || !current) {
    return (
      <p className="text-[var(--text-3)] text-sm">
        No prompt snapshot captured for this campaign yet. Snapshots are taken on clone / rebind. Older
        campaigns may not have one.
      </p>
    );
  }

  return (
    <>
      {versions.length > 1 && (
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-3)]">Version</span>
          {versions.map((v, i) => (
            <button
              key={v.id}
              onClick={() => setIdx(i)}
              className={`px-2.5 py-1 rounded-lg text-xs transition ${
                i === idx ? "bg-primary text-white" : "border border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
              }`}
            >
              {i === 0 ? "Latest" : `v${versions.length - i}`} · {fmtDate(v.created_at)}
            </button>
          ))}
        </div>
      )}

      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-center gap-4 text-[11px] text-[var(--text-3)] flex-wrap">
          {modelName && (
            <span>
              Model: <span className="text-[var(--text-2)] font-mono">{modelName}</span>
            </span>
          )}
          {current.asCreated ? (
            <span className="text-amber-400">As created · {fmtDate(current.created_at)} · stored on the campaign</span>
          ) : (
            <>
              <span>
                Captured: <span className="text-[var(--text-2)]">{fmtDate(current.created_at)}</span>
              </span>
              <span className="font-mono">sha {current.prompt_sha256.slice(0, 8)}</span>
            </>
          )}
        </div>
        <button
          onClick={copy}
          className={`shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[11px] font-medium border transition ${
            copied
              ? "border-emerald-500/40 text-emerald-400 bg-emerald-500/10"
              : "border-[var(--border)] text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]"
          }`}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? "Copied" : "Copy prompt"}
        </button>
      </div>

      <pre className="text-[12px] leading-relaxed text-[var(--text-1)] whitespace-pre-wrap font-mono bg-[var(--bg-app)] border border-[var(--border)] rounded-xl p-4">
        {current.system_prompt}
      </pre>
    </>
  );
}
