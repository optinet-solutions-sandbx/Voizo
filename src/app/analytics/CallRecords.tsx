"use client";

// Expandable call-records panel for a Campaign Performance row. One row per campaign_number,
// surfacing TWO complementary lenses:
//   • Status  — the contact's DISPOSITION / lifecycle (Successful / Not Interested / Awaiting
//               Retry / Voicemail / Unreached / Wrong Number).
//   • Attempt 1, Attempt 2, … — the per-call OUTCOME (Positive response / Neutral / Declined /
//               Early hangup / Voicemail detected / Unreachable) + the date·time of each attempt.
// They answer different questions, so they never duplicate (a contact can be "Awaiting Retry"
// whose Attempt 1 = "Voicemail detected"). Two filters (status + outcome) slice each axis; the
// export categories use the outcome taxonomy. Data: /api/dashboard/campaigns/[id]/records.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CallRecord,
  type CallAttempt,
  type ContactTag,
  type AttemptTag,
  type RecordStatus,
  ATTEMPT_TAG_LABELS,
  ATTEMPT_TAG_COLOR,
} from "@/lib/dashboardAnalytics";
import ExportMenu from "./ExportMenu";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import DatePickerField from "@/components/DatePickerField";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Status column = contact DISPOSITION (lifecycle). Calm muted chips (matches CampaignSummary).
const DISPO_ORDER: RecordStatus[] = ["successful", "not_interested", "awaiting_retry", "voicemail", "unreached", "wrong_number"];
const DISPO_LABEL: Record<RecordStatus, string> = {
  successful: "Successful",
  not_interested: "Not Interested",
  awaiting_retry: "Awaiting Retry",
  voicemail: "Voicemail",
  unreached: "Unreached",
  wrong_number: "Wrong Number",
};
const DISPO_COLOR: Record<RecordStatus, string> = {
  successful: "#5fb39a",
  not_interested: "#cf8a8a",
  awaiting_retry: "#c9a86a",
  voicemail: "#9f90c9",
  unreached: "#8b939c",
  wrong_number: "#8b939c",
};
// Attempt columns + the outcome filter = per-call OUTCOME categories (the AttemptTag set).
const OUTCOME_ORDER: AttemptTag[] = ["positive", "neutral", "declined", "early_hangup", "voicemail", "unreachable"];

// Cap attempt columns; a contact with more attempts than this folds the overflow into the last
// visible column ("+N more"). Keeps the table from sprawling on heavy-retry rosters.
const MAX_ATTEMPT_COLS = 5;

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...DISPO_ORDER.map((s) => ({ value: s, label: DISPO_LABEL[s] })),
];
const OUTCOME_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All outcomes" },
  ...OUTCOME_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
];
const HOUR_DROPDOWN: DropdownOption[] = [
  { value: "any", label: "Any hour" },
  ...Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, "0")}:00` })),
];

function fmtDateTime(ms: number | null): string {
  if (ms === null) return "—";
  const d = new Date(ms);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} · ${hh}:${mm}`;
}

const inputCls =
  "px-3 py-2 text-sm rounded-lg bg-[var(--bg-app)] border border-[var(--border)] text-[var(--text-1)] focus:outline-none focus:border-blue-500";

// Calm muted chip — colored dot + label, matching CampaignSummary's legend treatment.
function Chip({ label, color }: { label: string; color: string }) {
  return (
    <span className="inline-flex w-fit max-w-full items-center gap-1.5 whitespace-nowrap rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-1)]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full opacity-90" style={{ background: color }} />
      {label}
    </span>
  );
}

// One attempt cell: outcome chip + the attempt time below it. `overflow` renders the
// "+N more" hint stacked beneath when this is the last visible column and the contact
// has additional attempts past the cap.
function AttemptCell({ attempt, overflow }: { attempt: CallAttempt | undefined; overflow: number }) {
  if (!attempt) return <td className="px-3 py-2 text-center text-[var(--text-3)] text-xs">—</td>;
  return (
    <td className="px-3 py-2 align-top">
      <div className="flex flex-col items-start gap-1">
        <Chip label={ATTEMPT_TAG_LABELS[attempt.tag]} color={ATTEMPT_TAG_COLOR[attempt.tag]} />
        <span className="pl-5 whitespace-nowrap font-mono text-[10.5px] text-[var(--text-3)] [font-variant-numeric:tabular-nums]">
          {fmtDateTime(attempt.atMs)}
        </span>
        {overflow > 0 && <span className="pl-5 text-[10.5px] text-[var(--text-3)]">+{overflow} more</span>}
      </div>
    </td>
  );
}

export default function CallRecords({ campaignId }: { campaignId: string }) {
  const [records, setRecords] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dispo, setDispo] = useState<RecordStatus | "all">("all"); // Status (disposition) filter
  const [outcome, setOutcome] = useState<AttemptTag | "all">("all"); // Outcome filter (contact's overall outcome)
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [hour, setHour] = useState<string>("any");
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
      if (dispo !== "all" && r.status !== dispo) return false;
      if (outcome !== "all" && r.tag !== outcome) return false;
      if (phone.trim() && !(r.phone ?? "").includes(phone.trim())) return false;
      if (r.lastAttemptedMs !== null) {
        const d = new Date(r.lastAttemptedMs);
        if (from && d.getTime() < Date.parse(`${from}T00:00:00Z`)) return false;
        if (to && d.getTime() > Date.parse(`${to}T23:59:59Z`)) return false;
        if (hour !== "any" && d.getUTCHours() !== Number(hour)) return false;
      } else if (from || to || hour !== "any") {
        return false; // never-attempted rows fall out when a time filter is active
      }
      return true;
    });
  }, [records, dispo, outcome, phone, from, to, hour]);

  // Dynamic attempt-column count: widest filtered contact, capped at MAX_ATTEMPT_COLS.
  const maxAttempts = useMemo(() => {
    let n = 0;
    for (const r of filtered) if (r.attempts.length > n) n = r.attempts.length;
    return Math.min(n, MAX_ATTEMPT_COLS);
  }, [filtered]);

  const attemptCols = Array.from({ length: maxAttempts }, (_, i) => i); // 0-based attempt indices
  const colSpan = 3 + maxAttempts; // # · Phone · Status · …attempts… · Last Attempted

  const anyFilter = dispo !== "all" || outcome !== "all" || from || to || hour !== "any" || phone;

  return (
    <div className="bg-[var(--bg-app)]/40 border-t border-[var(--border)] px-5 py-4">
      {/* Center the records module and cap its width so rows don't overstretch on wide
          desktops; the inner overflow-x-auto + min-w keeps it scrollable on narrow screens. */}
      <div className="mx-auto w-fit max-w-6xl">
      {/* Exports (CSV + Audio + Transcripts), by outcome category. */}
      <div className="mb-3">
        <ExportMenu campaignId={campaignId} records={records ?? []} />
      </div>
      {/* Filters: Status (disposition) + Outcome (per-call) + date / hour / phone. */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="w-[160px]">
          <StyledSelect size="sm" value={dispo} onChange={(v) => setDispo(v as RecordStatus | "all")} options={STATUS_DROPDOWN} />
        </div>
        <div className="w-[170px]">
          <StyledSelect size="sm" value={outcome} onChange={(v) => setOutcome(v as AttemptTag | "all")} options={OUTCOME_DROPDOWN} />
        </div>
        <DatePickerField value={from} onChange={setFrom} placeholder="From date" ariaLabel="From date" />
        <span className="text-[var(--text-3)] text-xs">→</span>
        <DatePickerField value={to} onChange={setTo} placeholder="To date" ariaLabel="To date" />
        <div className="w-[130px]">
          <StyledSelect size="sm" value={hour} onChange={setHour} options={HOUR_DROPDOWN} />
        </div>
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          placeholder="Search number…"
          className={`${inputCls} w-[160px]`}
        />
        {anyFilter && (
          <button
            onClick={() => { setDispo("all"); setOutcome("all"); setFrom(""); setTo(""); setHour("any"); setPhone(""); }}
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
          <div className="overflow-x-auto rounded-xl border border-[var(--border)]">
            <table className="w-auto mx-auto text-sm min-w-[640px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2 w-10">#</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Phone Number</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Status</th>
                  {attemptCols.map((i) => (
                    <th key={i} className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">
                      Attempt {i + 1}
                    </th>
                  ))}
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Last Attempted</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={colSpan} className="px-3 py-8 text-center text-xs text-[var(--text-3)]">
                      No matching call records.
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => (
                    <tr key={r.campaignNumberId} className="border-b border-[var(--border)] last:border-b-0 align-top">
                      <td className="px-3 py-2 text-[var(--text-3)] font-mono text-xs">{i + 1}</td>
                      <td className="px-3 py-2 font-mono text-[var(--text-1)] text-xs">{r.phone ?? "—"}</td>
                      <td className="px-3 py-2">
                        <Chip label={DISPO_LABEL[r.status]} color={DISPO_COLOR[r.status]} />
                      </td>
                      {/* Fixed positional columns (Attempt 1..N) — they never reorder, so the column
                          index IS the stable key here. (react-doctor's no-index-key rule targets
                          reorderable item lists; the rows are keyed by campaignNumberId above.) */}
                      {attemptCols.map((idx) => {
                        const isLastCol = idx === maxAttempts - 1;
                        const overflow = isLastCol ? Math.max(0, r.attempts.length - maxAttempts) : 0;
                        return <AttemptCell key={`attempt-${idx}`} attempt={r.attempts[idx]} overflow={overflow} />;
                      })}
                      <td className="px-3 py-2 whitespace-nowrap font-mono text-[var(--text-2)] text-xs">{fmtDateTime(r.lastAttemptedMs)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[var(--text-3)] mt-2">
            Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} contacts.
          </p>
        </>
      )}
      </div>
    </div>
  );
}
