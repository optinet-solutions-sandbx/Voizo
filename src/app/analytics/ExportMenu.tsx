"use client";

// Per-campaign CSV + Audio export dropdowns (Slice 3c) for the expandable call-records
// panel. Reuses the shipped useCampaignExport hook (CSV w/ transcripts + audio-recordings
// zip via the recordings proxy) — no rebuild. Labels use the export's HONEST filter
// semantics; counts are best-effort from the visible records. The hook's progress/error
// surfaces inline (acts as the toast). NOTE: "voicemail" / "wrong_number" are 0 today
// (unstored buckets) — consistent with the records table.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { FileText, Mic, ChevronDown } from "lucide-react";
import { useCampaignExport, type ExportType } from "@/lib/useCampaignExport";
import type { CallRecord } from "@/lib/dashboardAnalytics";

const CSV_OPTS: { label: string; type: ExportType }[] = [
  { label: "All Calls", type: "all" },
  { label: "SMS Sent", type: "sms_sent" },
  { label: "Not Interested", type: "not_interested_or_declined" },
  { label: "Voicemails", type: "voicemail" },
  { label: "Unreached / Retry", type: "unreached_or_retry" },
  { label: "Wrong Numbers", type: "wrong_number" },
];
const AUDIO_OPTS: { label: string; type: ExportType }[] = [
  { label: "All Recordings", type: "all" },
  { label: "SMS Sent", type: "sms_sent" },
  { label: "Voicemail Only", type: "voicemail" },
];

// Approximate count from the visible records (mapped to the export filter).
function csvCount(type: ExportType, records: CallRecord[]): number {
  switch (type) {
    case "all":
      return records.length;
    case "sms_sent":
      return records.filter((r) => r.status === "successful").length;
    case "not_interested_or_declined":
      return records.filter((r) => r.status === "not_interested").length;
    case "voicemail":
      return records.filter((r) => r.status === "voicemail").length;
    case "unreached_or_retry":
      return records.filter((r) => r.status === "unreached" || r.status === "awaiting_retry").length;
    case "wrong_number":
      return records.filter((r) => r.status === "wrong_number").length;
    default:
      return 0;
  }
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
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <Dropdown
        label="CSV Export"
        icon={<FileText size={13} />}
        options={CSV_OPTS}
        records={records}
        showCount
        disabled={exporting}
        onPick={(t) => startExport(t, false)}
      />
      <Dropdown
        label="Audio Export"
        icon={<Mic size={13} />}
        options={AUDIO_OPTS}
        records={records}
        showCount={false}
        disabled={exporting}
        onPick={(t) => startExport(t, true)}
      />
      {exporting && <span className="text-[11px] text-[var(--text-3)]">{progress.stage || "Exporting…"}</span>}
      {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
    </div>
  );
}
