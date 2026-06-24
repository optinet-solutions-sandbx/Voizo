"use client";

// Per-campaign CSV + Audio + Transcripts export dropdowns (Slice 3c) for the
// expandable call-records panel. Reuses the shipped useCampaignExport hook
// (CSV w/ transcripts, audio-recordings zip via the recordings proxy, and the
// transcript .txt bundle) — no rebuild. Categories use the UNIFIED taxonomy
// (the dashboardAnalytics ContactTag contract); counts are best-effort from the
// visible records' contact tag. The hook's progress/error surfaces inline (acts
// as the toast).

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Mic, ScrollText, ChevronDown } from "lucide-react";
import {
  useCampaignExport,
  type ExportType,
  type ExportMode,
} from "@/lib/useCampaignExport";
import { type CallRecord, ATTEMPT_TAG_LABELS } from "@/lib/dashboardAnalytics";

// Unified category set, shared across CSV / Audio / Transcripts. Labels come
// from the contract's ATTEMPT_TAG_LABELS so they never drift from the records
// table. "all" is the only non-tag entry.
const CATEGORY_OPTS: { label: string; type: ExportType }[] = [
  { label: "All Calls", type: "all" },
  { label: ATTEMPT_TAG_LABELS.positive, type: "positive" },
  { label: ATTEMPT_TAG_LABELS.neutral, type: "neutral" },
  { label: ATTEMPT_TAG_LABELS.declined, type: "declined" },
  { label: ATTEMPT_TAG_LABELS.early_hangup, type: "early_hangup" },
  { label: ATTEMPT_TAG_LABELS.voicemail, type: "voicemail" },
  { label: ATTEMPT_TAG_LABELS.unreachable, type: "unreachable" },
];

// Approximate count from the visible records, by the record's CONTACT tag —
// matches the server-side filter (a contact matches a category when its tag
// === the category; "all" = every record). Contacts whose tag is awaiting_retry
// or wrong_number only ever fall under "all".
function csvCount(type: ExportType, records: CallRecord[]): number {
  if (type === "all") return records.length;
  return records.filter((r) => r.tag === type).length;
}

function Dropdown({
  label,
  icon,
  options,
  records,
  showCount,
  disabled,
  onPick,
}: {
  label: string;
  icon: ReactNode;
  options: { label: string; type: ExportType }[];
  records: CallRecord[];
  showCount: boolean;
  disabled: boolean;
  onPick: (type: ExportType) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1.5 rounded-lg border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {icon}
        {label}
        <ChevronDown size={12} className={`transition-transform ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div className="absolute z-50 mt-1.5 min-w-[200px] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
          {options.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => { onPick(o.type); setOpen(false); }}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-2 text-sm text-left text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              <span>{o.label}</span>
              {showCount && <span className="text-[11px] font-mono text-[var(--text-3)]">{csvCount(o.type, records).toLocaleString()}</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export default function ExportMenu({ campaignId, records }: { campaignId: string; records: CallRecord[] }) {
  const { startExport, exporting, progress, error } = useCampaignExport(campaignId);
  const pick = (mode: ExportMode) => (t: ExportType) => startExport(t, mode);
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Dropdown
        label="CSV Export"
        icon={<FileText size={13} />}
        options={CATEGORY_OPTS}
        records={records}
        showCount
        disabled={exporting}
        onPick={pick("csv")}
      />
      <Dropdown
        label="Audio Export"
        icon={<Mic size={13} />}
        options={CATEGORY_OPTS}
        records={records}
        showCount={false}
        disabled={exporting}
        onPick={pick("audio")}
      />
      <Dropdown
        label="Transcripts Export"
        icon={<ScrollText size={13} />}
        options={CATEGORY_OPTS}
        records={records}
        showCount={false}
        disabled={exporting}
        onPick={pick("transcripts")}
      />
      {exporting && <span className="text-[11px] text-[var(--text-3)]">{progress.stage || "Exporting…"}</span>}
      {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
    </div>
  );
}
