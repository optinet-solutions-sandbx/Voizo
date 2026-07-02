"use client";

// Campaign Performance table (Val's endgame mockup, Slice C). Has its OWN date range + status chips,
// INDEPENDENT of the global filter bar above. Sort by Newest/Call Attempts/Reached/SMS (default
// Newest). Each row is the SHARED CampaignRow (the same camp-row as Today's campaigns): chips
// (country/players/date) + a derived status pill (incl. "Ended") + run window + three compact
// BreakdownColumns (Attempts/Reached/SMS, campaign-LIFETIME). Expands to the reused CampaignExpand
// (records + CSV/Audio/Transcripts); a "trailing" link opens the /campaigns/v2/[id] detail page.
// Data: /api/dashboard/campaigns?from=&to=.

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import type { TodayPerfDay } from "@/lib/dashboardAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import PromptModal from "./PromptModal";
import DatePickerField from "@/components/DatePickerField";
import Pagination from "@/components/Pagination";
import { SortControl, type SortKey } from "./RankedTables";
import { useExpandSlices } from "./useExpandSlices";
import { CampaignRowsSkeleton } from "./loadingSkeletons";
import WidgetCard from "./WidgetCard";
import CampaignRow, { CAMPAIGN_ROW_GRID, type CampaignRowData, type DisplayStatus, STATUS_META } from "./CampaignRow";

interface Row {
  id: string;
  name: string;
  country: string;
  displayStatus: DisplayStatus;
  scheduleType: "fixed" | "recurring";
  voiceId: string | null;
  agentLabel: string | null;
  baseAssistantId: string | null;
  calls: number;
  connected: number;
  terminal: number;
  successful: number;
  connectRate: number | null;
  successRate: number | null;
  players: number; // campaign roster size (lifetime)
  reach: number; // human-only connects in window
  smsSent: number; // texts dispatched for this campaign
  startAt: string | null;
  endAt: string | null;
  lastCallAt: string | null;
  perf: TodayPerfDay; // per-campaign LIFETIME breakdown for the camp-row columns
}
interface Resp {
  from: string;
  to: string;
  rows: Row[];
}

const STATUS_ORDER: DisplayStatus[] = ["running", "completed", "ended", "paused", "inactive"];

const PAGE_SIZE = 5; // rows per page (Jasiel 2026-07-01: 5 → less scrolling, paginate the rest)

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function fmtShort(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function runWindow(r: Row): string {
  const start = fmtShort(r.startAt);
  if (!start) return "—";
  if (r.displayStatus === "running" || r.displayStatus === "paused") return `${start} → ongoing`;
  return `${start} → ${fmtShort(r.endAt ?? r.lastCallAt) ?? "ended"}`;
}

const DAY_MS = 86_400_000;
// Parse a YYYY-MM-DD picker value into a UTC ms bound. endOfDay pushes to 23:59:59.999
// so the To date is inclusive (mirrors the API's parseDay). Invalid/empty → null (no bound).
function parseDayMs(value: string, endOfDay: boolean): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const base = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return endOfDay ? base + DAY_MS - 1 : base;
}

// Does this campaign have call activity that intersects the picked [from, to] window?
// Row metrics are LIFETIME (server no longer windows them); the picker only filters WHICH
// campaigns are listed. We use the campaign's activity span — run-window start through its
// last-call (or end_at) — and keep the row only if that span overlaps the picked range.
// Campaigns with NO call activity (no lastCallAt) and no usable window are dropped when a
// filter is set. fromMs null = open lower bound; toMs null = open upper bound.
function activeInRange(r: Row, fromMs: number | null, toMs: number | null): boolean {
  if (fromMs === null && toMs === null) return true; // no filter → show all
  const startMs = r.startAt ? Date.parse(r.startAt) : NaN;
  const lastMs = r.lastCallAt ? Date.parse(r.lastCallAt) : NaN;
  const endMs = r.endAt ? Date.parse(r.endAt) : NaN;
  // Activity span end = last call ever, else campaign end, else its start (a point).
  const spanEnd = Number.isFinite(lastMs) ? lastMs : Number.isFinite(endMs) ? endMs : startMs;
  const spanStart = Number.isFinite(startMs) ? startMs : spanEnd;
  // Drop campaigns with no usable activity signal at all once a filter is active.
  if (!Number.isFinite(spanStart) && !Number.isFinite(spanEnd)) return false;
  const lo = fromMs ?? Number.NEGATIVE_INFINITY;
  const hi = toMs ?? Number.POSITIVE_INFINITY;
  // Overlap test: [spanStart, spanEnd] intersects [lo, hi].
  return spanStart <= hi && spanEnd >= lo;
}

function sortValue(r: Row, key: SortKey): number {
  if (key === "calls") return r.perf.callAttempts.total; // "Call Attempts" column
  if (key === "reached") return r.perf.reached.total;
  if (key === "sms") return r.perf.sms.total;
  if (key === "newest") {
    // Newest first (desc): run-window start as ms. No created_at in the payload,
    // so startAt is the truest available recency proxy. Null/invalid → sort last.
    const t = r.startAt ? Date.parse(r.startAt) : NaN;
    return Number.isFinite(t) ? t : -1;
  }
  return r.perf.callAttempts.total; // fallback (e.g. a stale "connect"/"success" key) → by attempts
}

export default function CampaignTable() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<DisplayStatus>>(new Set());
  const [sort, setSort] = useState<SortKey>("newest");
  // Expand + per-row slice state (straight-to-records, Val's mockup) — shared hook.
  const { expanded, slices, toggleExpand, pickMetric, clearSlice } = useExpandSlices();
  const [promptFor, setPromptFor] = useState<{ id: string; title: string } | null>(null);
  const [page, setPage] = useState(1);

  // The server returns ALL live campaigns with LIFETIME metrics regardless of from/to (it does not
  // window them). So we fetch ONCE and let the date range filter the list client-side (see `visible`
  // + activeInRange). No refetch on date change — that would re-run a heavy fetchAllRows for identical
  // data. The date range narrows WHICH campaigns are listed (by activity overlap); the numbers stay lifetime.
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/dashboard/campaigns`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as Resp);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Reset to page 1 whenever a filter/sort/date changes — done in the handlers (matches the SortControl
  // pattern in RankedTables), NOT a state→state effect. `safePage` still clamps as a safety net so you
  // never land on an empty page.
  const toggleStatus = (s: DisplayStatus) => {
    setPage(1);
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  const rows = useMemo(() => data?.rows ?? [], [data]);

  // Date range (client-side): keep campaigns whose activity span overlaps the picked [from, to].
  const fromMs = parseDayMs(from, false);
  const toMs = parseDayMs(to, true);
  const visible = rows
    .filter((r) => !hidden.has(r.displayStatus) && activeInRange(r, fromMs, toMs))
    .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <>
    <WidgetCard
      title="Campaign Performance"
      context="status, run window & full call records · its own date range"
      actions={
        <SortControl
          sort={sort}
          setSort={(s) => { setSort(s); setPage(1); }}
          keys={["newest", "calls", "reached", "sms"]}
          labels={{ newest: "Newest", calls: "Call Attempts", reached: "Reached", sms: "SMS" }}
        />
      }
      bodyClassName="p-0"
      footer={
        <Pagination
          currentPage={safePage}
          totalPages={totalPages}
          totalItems={visible.length}
          pageSize={PAGE_SIZE}
          onPageChange={setPage}
        />
      }
    >
      {/* Table-level filters (independent of the global bar). */}
      <div className="flex items-center gap-2 flex-wrap px-3.5 py-2.5 border-b border-[var(--border)]">
        {STATUS_ORDER.map((s) => {
          const on = !hidden.has(s);
          const m = STATUS_META[s];
          return (
            <button
              key={s}
              onClick={() => toggleStatus(s)}
              className={`px-2.5 py-1 rounded-full text-xs font-medium border transition ${
                on ? m.cls : "bg-transparent text-[var(--text-3)] border-[var(--border)] opacity-50"
              }`}
            >
              {m.label}
            </button>
          );
        })}
        <span className="w-px h-5 bg-[var(--border)] mx-1" />
        <DatePickerField value={from} onChange={(v) => { setFrom(v); setPage(1); }} placeholder="From date" ariaLabel="From date" />
        <span className="text-[var(--text-3)] text-xs">→</span>
        <DatePickerField value={to} onChange={(v) => { setTo(v); setPage(1); }} placeholder="To date" ariaLabel="To date" />
        {(from || to) && (
          <button type="button" onClick={() => { setFrom(""); setTo(""); setPage(1); }} className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]">
            Reset
          </button>
        )}
        <span className="text-[11px] text-[var(--text-3)]">{from || to ? "activity in range · lifetime totals" : "all campaigns · lifetime totals"}</span>
        {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
        {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
      </div>

      {/* Rows (shared camp-row, same as Today's campaigns). WidgetCard is the frame. */}
      <div className="overflow-x-auto">
        <div className="min-w-[920px]">
            {/* Header */}
            <div className={`${CAMPAIGN_ROW_GRID} px-4 py-3 border-b border-[var(--border)] text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]`}>
              <div>Campaign</div>
              <div>Status</div>
              <div>Call attempts</div>
              <div>Reached</div>
              <div>SMS sent</div>
            </div>

            {visible.length === 0 ? (
              data ? (
                <div className="px-4 py-10 text-center text-xs text-[var(--text-3)]">No campaigns match these filters.</div>
              ) : (
                <CampaignRowsSkeleton rows={PAGE_SIZE} />
              )
            ) : (
              pageRows.map((r) => {
                const rowData: CampaignRowData = {
                  id: r.id,
                  name: r.name,
                  country: r.country,
                  voiceId: r.voiceId,
                  agentLabel: r.agentLabel,
                  baseAssistantId: r.baseAssistantId,
                  scheduleType: r.scheduleType,
                  status: r.displayStatus,
                  timeLabel: runWindow(r),
                  players: r.players,
                  startAt: r.startAt,
                  perf: r.perf,
                };
                return (
                  <CampaignRow
                    key={r.id}
                    c={rowData}
                    expanded={expanded.has(r.id)}
                    onToggle={() => toggleExpand(r.id)}
                    slice={slices[r.id]?.slice}
                    sliceLabel={slices[r.id]?.label}
                    onMetricPick={(s, l) => pickMetric(r.id, s, l)}
                    onClearSlice={() => clearSlice(r.id)}
                    onViewPrompt={() => setPromptFor({ id: r.id, title: formatCampaign(r.name).display })}
                    trailing={
                      <>
                        <span className="text-[var(--border-2)]">·</span>
                        <Link
                          href={`/campaigns/v2/${r.id}`}
                          className="inline-flex items-center gap-1 text-[var(--text-2)] hover:text-primary transition-colors"
                        >
                          open in campaign <ArrowRight size={10} />
                        </Link>
                      </>
                    }
                  />
                );
              })
            )}
        </div>
      </div>
    </WidgetCard>

    {promptFor && (
      <PromptModal campaignId={promptFor.id} title={promptFor.title} onClose={() => setPromptFor(null)} />
    )}
    </>
  );
}
