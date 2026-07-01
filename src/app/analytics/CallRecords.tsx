"use client";

// Expandable call-records panel for a Campaign Performance row. One row per campaign_number,
// surfacing TWO complementary lenses:
//   • Status  — the contact's DISPOSITION / lifecycle (Successful / Not Interested / Awaiting
//               Retry / Voicemail / Unreached / Wrong Number).
//   • Attempt 1, Attempt 2, … — the per-call OUTCOME (Positive response / Neutral / Declined /
//               Early hangup / Voicemail detected / Unreachable) + the date·time of each attempt.
// They answer different questions, so they never duplicate (a contact can be "Awaiting Retry"
// whose Attempt 1 = "Voicemail detected"). Two ORTHOGONAL filters: Status filters the contact
// disposition; Attempt-outcome filters the per-attempt cells (matches a contact if ANY attempt
// carries the tag, via recordHasAttemptOutcome). The outcome categories are best-effort PROXY
// classifications (flagged "estimated" in the UI, defined in ATTEMPT_TAG_DESC tooltips), and the
// export categories use the same taxonomy. Data: /api/dashboard/campaigns/[id]/records.
// The table view lives in RecordsTable.tsx (shared with the Today's Performance drawer); this
// component owns fetching, the filter chrome, exports, and the "Showing N" footer.

import { useCallback, useEffect, useMemo, useState } from "react";
import { X } from "lucide-react";
import {
  type CallRecord,
  type AttemptTag,
  type RecordStatus,
  ATTEMPT_TAG_LABELS,
  recordHasAttemptOutcome,
} from "@/lib/dashboardAnalytics";
import ExportMenu from "./ExportMenu";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import RecordsTable from "./RecordsTable";
import { DISPO_ORDER, DISPO_LABEL, OUTCOME_ORDER, sliceMatches, type RecordSlice } from "./recordsDisplay";

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...DISPO_ORDER.map((s) => ({ value: s, label: DISPO_LABEL[s] })),
];
const OUTCOME_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All attempt outcomes" },
  ...OUTCOME_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
];

const inputCls =
  "px-3 py-2 text-sm rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-blue-500";

export default function CallRecords({
  campaignId,
  slice,
  sliceLabel,
  onClose,
}: {
  campaignId: string;
  slice?: RecordSlice; // metric-pick from the expanded row (the primary filter); undefined = no slice
  sliceLabel?: string;
  onClose?: () => void;
}) {
  const [records, setRecords] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dispo, setDispo] = useState<RecordStatus | "all">("all"); // Status (disposition) filter
  const [outcome, setOutcome] = useState<AttemptTag | "all">("all"); // Attempt-outcome filter (matches any attempt)
  const [phone, setPhone] = useState("");

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/dashboard/campaigns/${campaignId}/records`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { records: CallRecord[] };
      setRecords(body.records);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [campaignId]);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    if (!records) return [];
    return records.filter((r) => {
      // Metric-pick slice (the clicked metric/row from the expanded row) — the primary filter.
      if (slice && !sliceMatches(r, slice)) return false;
      if (dispo !== "all" && r.status !== dispo) return false;
      // Attempt-outcome is a PER-ATTEMPT axis: a contact matches if ANY of its attempts carries
      // the tag (orthogonal to the contact-level disposition filter above).
      if (outcome !== "all" && !recordHasAttemptOutcome(r, outcome)) return false;
      if (phone.trim() && !(r.phone ?? "").includes(phone.trim())) return false;
      return true;
    });
  }, [records, slice, dispo, outcome, phone]);

  const anyFilter = dispo !== "all" || outcome !== "all" || phone;

  return (
    <div className="bg-[var(--bg-app)]/40 border-t border-[var(--border)] px-5 py-4">
      {/* Center the records module and cap its width so rows don't overstretch on wide
          desktops; the inner overflow-x-auto + min-w keeps it scrollable on narrow screens. */}
      <div className="mx-auto w-full max-w-6xl">
        {/* Active metric-pick slice (from the expanded row) — labels the view; × closes the records. */}
        {slice && (
          <div className="mb-3">
            <span className="inline-flex items-center gap-2 rounded-full border border-blue-500/30 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-300">
              {sliceLabel ?? "Filtered"}
              {onClose && (
                <button type="button" onClick={onClose} aria-label="Close records" className="text-blue-300/70 transition hover:text-blue-200">
                  <X size={12} />
                </button>
              )}
            </span>
          </div>
        )}
        {/* Exports (CSV + Audio + Transcripts), by outcome category. */}
        <div className="mb-3">
          <ExportMenu campaignId={campaignId} records={records ?? []} />
        </div>
        {/* Filters (orthogonal): Status = contact disposition · Attempt outcome = per-attempt (estimated) · phone search. */}
        <div className="flex items-center gap-2 flex-wrap mb-3">
          <div className="w-[160px]">
            <StyledSelect size="sm" value={dispo} onChange={(v) => setDispo(v as RecordStatus | "all")} options={STATUS_DROPDOWN} />
          </div>
          <div className="w-[200px]">
            <StyledSelect size="sm" value={outcome} onChange={(v) => setOutcome(v as AttemptTag | "all")} options={OUTCOME_DROPDOWN} />
          </div>
          {/* Honesty signal: the attempt-outcome categories are best-effort proxies (see per-chip tooltips). */}
          <span
            title="Attempt outcomes are best-effort classifications from call data, not verified labels."
            className="cursor-help rounded border border-[var(--border-2)] px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.12em] text-[var(--text-2)]"
          >
            Estimated
          </span>
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="Search number…"
            className={`${inputCls} w-[160px]`}
          />
          {anyFilter && (
            <button
              onClick={() => { setDispo("all"); setOutcome("all"); setPhone(""); }}
              className="text-sm text-[var(--text-2)] hover:text-[var(--text-1)] px-2.5 py-2 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]"
            >
              Reset
            </button>
          )}
        </div>

        {/* Records. */}
        {error ? (
          <p className="text-xs text-amber-400 font-mono py-3">{error}</p>
        ) : !records ? (
          <p className="text-xs text-[var(--text-3)] py-3">Loading call records…</p>
        ) : (
          <>
            <RecordsTable records={filtered} />
            <p className="text-[11px] text-[var(--text-3)] mt-2">
              Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} contacts.
            </p>
          </>
        )}
      </div>
    </div>
  );
}
