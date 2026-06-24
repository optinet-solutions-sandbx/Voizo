"use client";

// Expandable call-records panel for a Campaign Performance row. One row per
// campaign_number, surfacing the contact-level outcome (Status) PLUS the ordered
// per-attempt tags (Attempt 1, Attempt 2, …) so an operator can read the dialing
// story at a glance. Per-panel filters: status (unified contact taxonomy) / date
// range / hour / phone. Data: /api/dashboard/campaigns/[id]/records.
// Taxonomy is the shared contract from "@/lib/dashboardAnalytics" (ContactTag /
// ATTEMPT_TAG_LABELS / ATTEMPT_TAG_COLOR) — same labels & muted accents everywhere.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type CallRecord,
  type CallAttempt,
  type ContactTag,
  ATTEMPT_TAG_LABELS,
  ATTEMPT_TAG_COLOR,
} from "@/lib/dashboardAnalytics";
import ExportMenu from "./ExportMenu";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import DatePickerField from "@/components/DatePickerField";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Unified filter/export categories — ATTEMPT_TAG_LABELS order (contact funnel: most→least
// engaged, then the no-call tails). Drives both the filter dropdown and `record.tag` matching.
const CONTACT_TAG_ORDER: ContactTag[] = [
  "positive",
  "neutral",
  "declined",
  "early_hangup",
  "voicemail",
  "unreachable",
  "awaiting_retry",
  "wrong_number",
];

// Cap attempt columns; a contact with more attempts than this folds the overflow into the
// last visible column ("+N more"). Keeps the table from sprawling on heavy-retry rosters.
const MAX_ATTEMPT_COLS = 5;

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...CONTACT_TAG_ORDER.map((t) => ({ value: t, label: ATTEMPT_TAG_LABELS[t] })),
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

// Small muted chip — colored dot + label, matching CampaignSummary's calm legend treatment.
function TagChip({ tag }: { tag: ContactTag }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--bg-elevated)] px-2 py-0.5 text-[11px] font-medium text-[var(--text-1)]">
      <span className="h-1.5 w-1.5 shrink-0 rounded-full opacity-90" style={{ background: ATTEMPT_TAG_COLOR[tag] }} />
      {ATTEMPT_TAG_LABELS[tag]}
    </span>
  );
}

// One attempt cell: muted chip + the attempt time below it. `overflow` renders the
// "+N more" hint stacked beneath when this is the last visible column and the contact
// has additional attempts past the cap.
function AttemptCell({ attempt, overflow }: { attempt: CallAttempt | undefined; overflow: number }) {
  if (!attempt) return <td className="px-3 py-2 text-center text-[var(--text-3)] text-xs">—</td>;
  return (
    <td className="px-3 py-2 align-top">
      <div className="flex flex-col gap-1">
        <TagChip tag={attempt.tag} />
        <span className="pl-3 font-mono text-[10.5px] text-[var(--text-3)] [font-variant-numeric:tabular-nums]">
          {fmtDateTime(attempt.atMs)}
        </span>
        {overflow > 0 && (
          <span className="pl-3 text-[10.5px] text-[var(--text-3)]">+{overflow} more</span>
        )}
      </div>
    </td>
  );
}

export default function CallRecords({ campaignId }: { campaignId: string }) {
  const [records, setRecords] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ContactTag | "all">("all");
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
      if (status !== "all" && r.tag !== status) return false;
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
  }, [records, status, phone, from, to, hour]);

  // Dynamic attempt-column count: widest filtered contact, capped at MAX_ATTEMPT_COLS.
  const maxAttempts = useMemo(() => {
    let n = 0;
    for (const r of filtered) if (r.attempts.length > n) n = r.attempts.length;
    return Math.min(n, MAX_ATTEMPT_COLS);
  }, [filtered]);

  const attemptCols = Array.from({ length: maxAttempts }, (_, i) => i); // 0-based attempt indices
  const colSpan = 3 + maxAttempts; // # · Phone · Status · …attempts… · Last Attempted

  return (
    <div className="bg-[var(--bg-app)]/40 border-t border-[var(--border)] px-5 py-4">
      {/* Exports (CSV + Audio), reusing the shipped useCampaignExport hook. */}
      <div className="mb-3">
        <ExportMenu campaignId={campaignId} records={records ?? []} />
      </div>
      {/* Filters. */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="w-[170px]">
          <StyledSelect
            size="sm"
            value={status}
            onChange={(v) => setStatus(v as ContactTag | "all")}
            options={STATUS_DROPDOWN}
          />
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
        {(status !== "all" || from || to || hour !== "any" || phone) && (
          <button
            onClick={() => { setStatus("all"); setFrom(""); setTo(""); setHour("any"); setPhone(""); }}
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
            <table className="w-full text-sm min-w-[640px]">
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
                        <TagChip tag={r.tag} />
                      </td>
                      {/* Fixed positional columns (Attempt 1..N) — they never reorder, so the column
                          index IS the stable key here. (react-doctor's no-index-key rule targets
                          reorderable item lists; the rows are keyed by campaignNumberId above.) */}
                      {attemptCols.map((idx) => {
                        const isLastCol = idx === maxAttempts - 1;
                        // Overflow only on the final visible column: how many attempts spill past the cap.
                        const overflow = isLastCol ? Math.max(0, r.attempts.length - maxAttempts) : 0;
                        return <AttemptCell key={`attempt-${idx}`} attempt={r.attempts[idx]} overflow={overflow} />;
                      })}
                      <td className="px-3 py-2 font-mono text-[var(--text-2)] text-xs">{fmtDateTime(r.lastAttemptedMs)}</td>
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
  );
}
