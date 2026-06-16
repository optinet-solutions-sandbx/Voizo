"use client";

// Expandable call-records panel for a Campaign Performance row (Slice 3b). One row per
// campaign_number: #, Phone, Status, Attempts, Last Attempted — with per-panel filters
// (status / date range / hour / phone). Data: /api/dashboard/campaigns/[id]/records.
// Voicemail + Wrong Number are underivable today (see lib) → they show 0 until the
// voicemail-persistence slice. Exports (CSV/Audio) land in Slice 3c.

import { useCallback, useEffect, useMemo, useState } from "react";
import type { CallRecord, RecordStatus } from "@/lib/dashboardAnalytics";
import ExportMenu from "./ExportMenu";
import StyledSelect, { type DropdownOption } from "@/components/StyledSelect";
import DatePickerField from "@/components/DatePickerField";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const REC_META: Record<RecordStatus, { label: string; cls: string }> = {
  successful: { label: "Successful", cls: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20" },
  not_interested: { label: "Not Interested", cls: "text-red-400 bg-red-500/10 border-red-500/20" },
  awaiting_retry: { label: "Awaiting Retry", cls: "text-amber-400 bg-amber-500/10 border-amber-500/20" },
  voicemail: { label: "Voicemail", cls: "text-indigo-400 bg-indigo-500/10 border-indigo-500/20" },
  unreached: { label: "Unreached", cls: "text-[var(--text-3)] bg-[var(--bg-elevated)] border-[var(--border)]" },
  wrong_number: { label: "Wrong Number", cls: "text-[var(--text-3)] bg-[var(--bg-elevated)] border-[var(--border)]" },
};
const STATUS_OPTIONS: RecordStatus[] = ["successful", "not_interested", "awaiting_retry", "voicemail", "unreached", "wrong_number"];

const STATUS_DROPDOWN: DropdownOption[] = [
  { value: "all", label: "All statuses" },
  ...STATUS_OPTIONS.map((s) => ({ value: s, label: REC_META[s].label })),
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

export default function CallRecords({ campaignId }: { campaignId: string }) {
  const [records, setRecords] = useState<CallRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<RecordStatus | "all">("all");
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
      if (status !== "all" && r.status !== status) return false;
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

  return (
    <div className="bg-[var(--bg-app)]/40 border-t border-[var(--border)] px-5 py-4">
      {/* Exports (CSV + Audio), reusing the shipped useCampaignExport hook. */}
      <div className="mb-3">
        <ExportMenu campaignId={campaignId} records={records ?? []} />
      </div>
      {/* Filters. */}
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <div className="w-[150px]">
          <StyledSelect
            size="sm"
            value={status}
            onChange={(v) => setStatus(v as RecordStatus | "all")}
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
            <table className="w-full text-sm min-w-[560px]">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2 w-10">#</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Phone Number</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Status</th>
                  <th className="text-right text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Attempts</th>
                  <th className="text-left text-[10px] uppercase tracking-wider text-[var(--text-3)] font-medium px-3 py-2">Last Attempted</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-8 text-center text-xs text-[var(--text-3)]">
                      No matching call records.
                    </td>
                  </tr>
                ) : (
                  filtered.map((r, i) => {
                    const m = REC_META[r.status];
                    return (
                      <tr key={r.campaignNumberId} className="border-b border-[var(--border)] last:border-b-0">
                        <td className="px-3 py-2 text-[var(--text-3)] font-mono text-xs">{i + 1}</td>
                        <td className="px-3 py-2 font-mono text-[var(--text-1)] text-xs">{r.phone ?? "—"}</td>
                        <td className="px-3 py-2">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${m.cls}`}>
                            {m.label}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-[var(--text-2)] text-xs">{r.attempts}</td>
                        <td className="px-3 py-2 font-mono text-[var(--text-2)] text-xs">{fmtDateTime(r.lastAttemptedMs)}</td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-[var(--text-3)] mt-2">
            Showing {filtered.length.toLocaleString()} of {records.length.toLocaleString()} call records · exports land next.
          </p>
        </>
      )}
    </div>
  );
}
