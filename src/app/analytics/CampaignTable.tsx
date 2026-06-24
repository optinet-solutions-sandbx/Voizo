"use client";

// Campaign Performance table (Val's spec). Has its OWN date range + status chips,
// INDEPENDENT of the global filter bar above. Sort by Calls/Connect/Success (default
// Success). Per row: campaign-colored dot + name (+country) + voice, Calls/Connect/Success,
// derived status pill (incl. "Ended"), run window, duration bar. Name links to the existing
// /campaigns/v2/[id] detail page (reuse). Expandable call records + exports = Slice 3b/3c.
// Data: /api/dashboard/campaigns?from=&to=.

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, ChevronRight } from "lucide-react";
import CampaignExpand from "@/components/analytics/CampaignExpand";
import type { CampaignAnalytics } from "@/lib/campaignAnalytics";
import { formatCampaign } from "@/lib/campaignDisplay";
import { voiceName } from "@/lib/voiceOptions";
import { useBaseAgentNames } from "./useBaseAgentNames";
import PromptModal from "./PromptModal";
import DatePickerField from "@/components/DatePickerField";
import Pagination from "@/components/Pagination";
import { SortControl, type SortKey } from "./RankedTables";

type DisplayStatus = "running" | "completed" | "ended" | "paused" | "inactive";

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
}
interface Resp {
  from: string;
  to: string;
  rows: Row[];
}

const STATUS_ORDER: DisplayStatus[] = ["running", "completed", "ended", "paused", "inactive"];
const STATUS_META: Record<DisplayStatus, { label: string; cls: string; pulse?: boolean }> = {
  running: { label: "Running", cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", pulse: true },
  completed: { label: "Completed", cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
  ended: { label: "Ended", cls: "bg-[var(--bg-elevated)] text-[var(--text-2)] border-[var(--border)]" },
  paused: { label: "Paused", cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  inactive: { label: "Inactive", cls: "bg-[var(--bg-elevated)] text-[var(--text-3)] border-[var(--border)]" },
};

const PAGE_SIZE = 10; // rows per page (mirrors the /campaigns list)

// Deterministic per-campaign color (stable across the dashboard; reused by charts later).
function campaignColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 68% 55%)`;
}

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

// Compact run duration ("1d 3h" / "6h" / "45m") from a span in ms. Reuses the
// span the bar already computes (start → end / last-call / range-end), so
// ongoing campaigns read as elapsed-so-far. Pure — no Date.now() in render.
function formatRunDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  if (totalMin < 1) return "<1m";
  const d = Math.floor(totalMin / 1440);
  const h = Math.floor((totalMin % 1440) / 60);
  const m = totalMin % 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return m > 0 ? `${h}h ${m}m` : `${h}h`;
  return `${m}m`;
}

function StatusPill({ s }: { s: DisplayStatus }) {
  const m = STATUS_META[s];
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${m.cls}`}>
      {m.pulse && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {m.label}
    </span>
  );
}

function sortValue(r: Row, key: SortKey): number {
  if (key === "calls") return r.calls; // "Attempts" column
  if (key === "reached") return r.reach;
  if (key === "sms") return r.smsSent;
  if (key === "newest") {
    // Newest first (desc): run-window start as ms. No created_at in the payload,
    // so startAt is the truest available recency proxy. Null/invalid → sort last.
    const t = r.startAt ? Date.parse(r.startAt) : NaN;
    return Number.isFinite(t) ? t : -1;
  }
  return r.calls; // fallback (e.g. a stale "connect"/"success" key) → by attempts
}

export default function CampaignTable() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [data, setData] = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState<Set<DisplayStatus>>(new Set());
  const [sort, setSort] = useState<SortKey>("newest");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [promptFor, setPromptFor] = useState<{ id: string; title: string } | null>(null);
  // Lazy per-campaign LIFETIME analytics for the rich expand (fetched on first expand).
  // undefined = not fetched/loading · null = no analytics (ghost/missing) · object = loaded.
  const [analytics, setAnalytics] = useState<Record<string, CampaignAnalytics | null>>({});
  const [page, setPage] = useState(1);
  const baseAgentName = useBaseAgentNames();

  const load = useCallback(async (f: string, t: string) => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      if (f) qs.set("from", f);
      if (t) qs.set("to", t);
      const res = await fetch(`/api/dashboard/campaigns?${qs.toString()}`, { cache: "no-store" });
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
    load(from, to);
  }, [load, from, to]);

  // Reset to page 1 whenever the filters/sort/date change so you never land on an empty page.
  useEffect(() => setPage(1), [hidden, sort, from, to]);

  const toggleStatus = (s: DisplayStatus) =>
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });

  const fetchAnalytics = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/dashboard/campaigns/${id}/analytics`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = (await res.json()) as { analytics: CampaignAnalytics | null };
      setAnalytics((prev) => ({ ...prev, [id]: body.analytics }));
    } catch {
      setAnalytics((prev) => ({ ...prev, [id]: null })); // degrade loudly in the UI, not silently
    }
  }, []);

  const toggleExpand = (id: string) => {
    const willExpand = !expanded.has(id);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (willExpand && analytics[id] === undefined) fetchAnalytics(id);
  };

  const { rows, maxSpan } = useMemo(() => {
    const rs = data?.rows ?? [];
    const refEnd = data ? Date.parse(data.to) : 0;
    const withSpan = rs.map((r) => {
      const startMs = r.startAt ? Date.parse(r.startAt) : NaN;
      const endMs = r.endAt ? Date.parse(r.endAt) : r.lastCallAt ? Date.parse(r.lastCallAt) : refEnd;
      const span = Number.isFinite(startMs) && Number.isFinite(endMs) ? Math.max(0, endMs - startMs) : 0;
      return { row: r, span };
    });
    const max = withSpan.reduce((m, x) => Math.max(m, x.span), 0) || 1;
    return { rows: withSpan, maxSpan: max };
  }, [data]);

  const visible = rows
    .filter((x) => !hidden.has(x.row.displayStatus))
    .sort((a, b) => sortValue(b.row, sort) - sortValue(a.row, sort));

  const totalPages = Math.max(1, Math.ceil(visible.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages);
  const pageRows = visible.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  return (
    <section className="grid gap-3">
      <div className="flex items-end justify-between gap-4 flex-wrap pt-2">
        <div>
          <h2 className="text-[20px] font-bold tracking-tight">Campaign Performance</h2>
          <p className="text-sm text-[var(--text-3)] mt-1">Status, run window &amp; full call records · its own date range.</p>
        </div>
        <SortControl
          sort={sort}
          setSort={setSort}
          keys={["newest", "calls", "reached", "sms"]}
          labels={{ newest: "Newest", calls: "Attempts", reached: "Reached", sms: "SMS" }}
        />
      </div>

      {/* Table-level filters (independent of the global bar). */}
      <div className="flex items-center gap-2 flex-wrap">
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
        <DatePickerField value={from} onChange={setFrom} placeholder="From date" ariaLabel="From date" />
        <span className="text-[var(--text-3)] text-xs">→</span>
        <DatePickerField value={to} onChange={setTo} placeholder="To date" ariaLabel="To date" />
        {(from || to) && (
          <button onClick={() => { setFrom(""); setTo(""); }} className="text-xs text-[var(--text-2)] hover:text-[var(--text-1)] px-2 py-1 rounded-lg border border-[var(--border)] hover:bg-[var(--bg-hover)]">
            Reset
          </button>
        )}
        {!from && !to && <span className="text-[11px] text-[var(--text-3)]">Last 30 days</span>}
        {loading && <span className="text-[11px] text-[var(--text-3)]">Updating…</span>}
        {error && <span className="text-[11px] text-amber-400 font-mono">{error}</span>}
      </div>

      {/* Table. */}
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[880px]">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="text-left font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-5 py-3">Campaign</th>
                <th className="text-right font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-3 py-3">Players</th>
                <th className="text-right font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-3 py-3">Attempts</th>
                <th className="text-right font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-3 py-3">Reached</th>
                <th className="text-right font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-3 py-3">SMS</th>
                <th className="text-left font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-3 py-3">Status</th>
                <th className="text-left font-medium text-[10px] uppercase tracking-wider text-[var(--text-3)] px-5 py-3">Run Window</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-5 py-10 text-center text-xs text-[var(--text-3)]">
                    {data ? "No campaigns match these filters." : "Loading campaigns…"}
                  </td>
                </tr>
              ) : (
                pageRows.map(({ row: r, span }) => (
                  <Fragment key={r.id}>
                    <tr className="group border-b border-[var(--border)] last:border-b-0 hover:bg-[var(--bg-hover)]/40 transition-colors">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => toggleExpand(r.id)}
                            className="text-[var(--text-3)] hover:text-[var(--text-1)] transition shrink-0"
                            aria-label={expanded.has(r.id) ? "Collapse call records" : "Expand call records"}
                          >
                            <ChevronRight size={14} className={`transition-transform ${expanded.has(r.id) ? "rotate-90" : ""}`} />
                          </button>
                          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: campaignColor(r.id) }} />
                          <div className="min-w-0">
                            <div className="flex items-center gap-2 min-w-0">
                              <button
                                type="button"
                                onClick={() => toggleExpand(r.id)}
                                title={r.name}
                                className="font-medium text-[var(--text-1)] hover:text-blue-400 transition-colors text-left min-w-0"
                              >
                                <span className="block truncate max-w-[260px]">{formatCampaign(r.name).display}</span>
                              </button>
                              <Link
                                href={`/campaigns/v2/${r.id}`}
                                className="opacity-0 group-hover:opacity-100 transition-opacity inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-[var(--border)] text-[10px] font-medium text-[var(--text-2)] hover:text-blue-400 hover:border-blue-400/40 whitespace-nowrap shrink-0"
                              >
                                Open in campaign <ArrowRight size={10} />
                              </Link>
                            </div>
                            <div className="text-[11px] text-[var(--text-3)] mt-0.5">
                              {baseAgentName(r.baseAssistantId) ?? voiceName(r.voiceId, { short: true }) ?? "—"}
                              {r.scheduleType === "recurring" ? " · recurring" : ""}
                              {" · "}
                              <button
                                onClick={() => setPromptFor({ id: r.id, title: formatCampaign(r.name).display })}
                                className="text-blue-400 hover:text-blue-300 transition-colors"
                              >
                                view prompt
                              </button>
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3 text-right font-mono text-[var(--text-2)]">{r.players.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right font-mono text-blue-400">{r.calls.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right font-mono text-teal-400">{r.reach.toLocaleString()}</td>
                      <td className="px-3 py-3 text-right font-mono text-sky-400">{r.smsSent.toLocaleString()}</td>
                      <td className="px-3 py-3"><StatusPill s={r.displayStatus} /></td>
                      <td className="px-5 py-3">
                        <div className="text-[11px] font-mono text-[var(--text-2)]">
                          {runWindow(r)}
                          {span > 0 && <span className="text-[var(--text-3)]"> · {formatRunDuration(span)}</span>}
                        </div>
                        <div className="mt-1.5 h-1 rounded-full bg-[var(--bg-elevated)] w-full max-w-[160px] overflow-hidden">
                          <div className="h-full rounded-full" style={{ width: `${Math.max(4, (span / maxSpan) * 100)}%`, backgroundColor: campaignColor(r.id) }} />
                        </div>
                      </td>
                    </tr>
                    {expanded.has(r.id) && (
                      <tr>
                        <td colSpan={7} className="p-0">
                          <div className="px-4 py-4 bg-[var(--bg-app)] border-b border-[var(--border)]">
                            {analytics[r.id] === undefined ? (
                              <p className="text-xs text-[var(--text-3)] py-2">Loading campaign analytics…</p>
                            ) : analytics[r.id] === null ? (
                              <p className="text-xs text-[var(--text-3)] py-2">No analytics available for this campaign.</p>
                            ) : (
                              <CampaignExpand a={analytics[r.id]!} />
                            )}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Pagination
        currentPage={safePage}
        totalPages={totalPages}
        totalItems={visible.length}
        pageSize={PAGE_SIZE}
        onPageChange={setPage}
      />

      {promptFor && (
        <PromptModal campaignId={promptFor.id} title={promptFor.title} onClose={() => setPromptFor(null)} />
      )}
    </section>
  );
}
