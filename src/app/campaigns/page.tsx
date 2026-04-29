"use client";

import React, { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Search, Plus, Loader2, Trash2, Archive, Phone, ArrowUpRight, X,
  Users, PhoneCall, Zap, Target,
} from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis,
} from "recharts";
import { fetchCampaignsV2 } from "@/lib/campaignV2Data";
import { supabase } from "@/lib/supabase";
import Pagination from "@/components/Pagination";

type CampaignRow = Record<string, unknown>;

interface CampaignStats {
  totalContacts: number;
  totalCalls: number;
  connectCount: number;
  successCount: number;
}

function lastNDays(n: number): string[] {
  const days: string[] = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    days.push(d.toLocaleDateString("en-US", { month: "short", day: "numeric" }));
  }
  return days;
}

const DAY_LABELS = lastNDays(7);

interface TooltipPayloadItem {
  value: number;
  payload?: { date?: string; pct?: number };
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: TooltipPayloadItem[] }) {
  if (!active || !payload?.length) return null;
  const { date, pct } = payload[0].payload ?? {};
  return (
    <div className="bg-[var(--bg-card)] border border-[var(--border)] text-xs rounded-lg px-2.5 py-1.5 shadow-xl pointer-events-none">
      <p className="font-semibold text-[var(--text-1)]">{date}</p>
      <p className="text-[var(--text-2)]">{pct !== undefined ? `${pct}%` : payload[0].value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { cls: string; dot?: boolean }> = {
    draft:     { cls: "bg-gray-500/10 text-gray-400 border-gray-500/20" },
    running:   { cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20", dot: true },
    paused:    { cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
    completed: { cls: "bg-blue-500/10 text-blue-400 border-blue-500/20" },
    archived:  { cls: "bg-gray-500/10 text-gray-400 border-gray-500/20" },
  };
  const { cls, dot } = map[status] ?? map.draft;
  return (
    <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-semibold border ${cls}`}>
      {dot && <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />}
      {status}
    </span>
  );
}

interface StatCardProps {
  title: string;
  value: string;
  subtitle: string;
  chart: React.ReactNode;
  accent: string;
  gradientFrom: string;
  gradientTo: string;
  icon: React.ElementType;
  iconColor: string;
}

function StatCard({ title, value, subtitle, chart, accent, gradientFrom, gradientTo, icon: Icon, iconColor }: StatCardProps) {
  return (
    <div className={`relative rounded-2xl border border-[var(--border)] p-4 sm:p-5 flex flex-col gap-2 overflow-hidden bg-gradient-to-br ${gradientFrom} ${gradientTo}`}>
      <div className="flex items-center gap-2">
        <Icon size={14} className={iconColor} />
        <p className="text-xs font-medium text-[var(--text-3)] uppercase tracking-wide">{title}</p>
      </div>
      <div className="h-12 sm:h-14 w-full opacity-80">
        <ResponsiveContainer width="100%" height="100%">
          {chart as React.ReactElement}
        </ResponsiveContainer>
      </div>
      <div className="flex items-end justify-between gap-2 mt-auto">
        <p className={`text-2xl sm:text-3xl font-bold tracking-tight leading-none ${accent}`}>{value}</p>
        <span className="text-[10px] text-[var(--text-3)] font-medium">{subtitle}</span>
      </div>
    </div>
  );
}

const PAGE_SIZE = 10;

export default function CampaignsPage() {
  const router = useRouter();
  const [campaigns, setCampaigns] = useState<CampaignRow[]>([]);
  const [campaignStats, setCampaignStats] = useState<Record<string, CampaignStats>>({});
  const [dailyCalls, setDailyCalls] = useState<{ date: string; calls: number; connects: number; successes: number }[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const rows = await fetchCampaignsV2();
        setCampaigns(rows);

        const ids = rows.map((r: CampaignRow) => r.id as string);
        if (ids.length === 0) { setLoading(false); return; }

        const [{ data: numbers }, { data: calls }] = await Promise.all([
          supabase
            .from("campaign_numbers_v2")
            .select("campaign_id, outcome")
            .in("campaign_id", ids),
          supabase
            .from("calls_v2")
            .select("campaign_id, status, goal_reached, created_at")
            .in("campaign_id", ids),
        ]);

        const s: Record<string, CampaignStats> = {};
        for (const id of ids) s[id] = { totalContacts: 0, totalCalls: 0, connectCount: 0, successCount: 0 };
        for (const n of numbers ?? []) {
          const cid = n.campaign_id as string;
          if (s[cid]) s[cid].totalContacts++;
        }
        for (const c of calls ?? []) {
          const cid = c.campaign_id as string;
          if (!s[cid]) continue;
          s[cid].totalCalls++;
          if (c.status === "completed" || c.status === "answered") s[cid].connectCount++;
          if (c.goal_reached === true) s[cid].successCount++;
        }
        setCampaignStats(s);

        const now = new Date();
        const sevenDaysAgo = new Date(now);
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 6);
        sevenDaysAgo.setHours(0, 0, 0, 0);

        const daily: Record<string, { calls: number; connects: number; successes: number }> = {};
        for (let i = 0; i < 7; i++) {
          const d = new Date(sevenDaysAgo);
          d.setDate(d.getDate() + i);
          daily[d.toISOString().slice(0, 10)] = { calls: 0, connects: 0, successes: 0 };
        }
        for (const c of calls ?? []) {
          const day = (c.created_at as string)?.slice(0, 10);
          if (day && daily[day]) {
            daily[day].calls++;
            if (c.status === "completed" || c.status === "answered") daily[day].connects++;
            if (c.goal_reached === true) daily[day].successes++;
          }
        }
        setDailyCalls(
          Object.entries(daily)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([date, v]) => ({ date, ...v })),
        );
      } catch (err) {
        console.error("Failed to fetch campaigns:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const totals = useMemo(() => {
    const vals = Object.values(campaignStats);
    const totalContacts = vals.reduce((s, v) => s + v.totalContacts, 0);
    const totalCalls = vals.reduce((s, v) => s + v.totalCalls, 0);
    const connectCount = vals.reduce((s, v) => s + v.connectCount, 0);
    const successCount = vals.reduce((s, v) => s + v.successCount, 0);
    const connectRate = totalCalls > 0 ? ((connectCount / totalCalls) * 100).toFixed(1) : "0";
    const successRate = connectCount > 0 ? ((successCount / connectCount) * 100).toFixed(1) : "0";
    return { totalContacts, totalCalls, connectCount, successCount, connectRate, successRate };
  }, [campaignStats]);

  const sparkContacts = useMemo(() => {
    const vals = Object.values(campaignStats).map((v) => v.totalContacts);
    const total = vals.reduce((s, v) => s + v, 0) || 1;
    return vals.slice(-7).map((v, i) => ({ i, v, date: DAY_LABELS[i] ?? "", pct: Math.round((v / total) * 100) }));
  }, [campaignStats]);

  const sparkCalls = useMemo(() => {
    const total = dailyCalls.reduce((s, d) => s + d.calls, 0) || 1;
    return dailyCalls.map((d, i) => ({ i, v: d.calls, date: DAY_LABELS[i] ?? "", pct: Math.round((d.calls / total) * 100) }));
  }, [dailyCalls]);

  const sparkConnect = useMemo(() => {
    return dailyCalls.map((d, i) => {
      const rate = d.calls > 0 ? Math.round((d.connects / d.calls) * 100) : 0;
      return { i, v: rate, date: DAY_LABELS[i] ?? "", pct: rate };
    });
  }, [dailyCalls]);

  const sparkSuccess = useMemo(() => {
    return dailyCalls.map((d, i) => {
      const rate = d.connects > 0 ? Math.round((d.successes / d.connects) * 100) : 0;
      return { i, v: rate, date: DAY_LABELS[i] ?? "", pct: rate };
    });
  }, [dailyCalls]);

  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return campaigns;
    const q = searchQuery.toLowerCase();
    return campaigns.filter((c) => (c.name as string).toLowerCase().includes(q));
  }, [campaigns, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  function handleSearch(q: string) { setSearchQuery(q); setCurrentPage(1); }

  async function handleDelete(id: string) {
    setDeleting(true);
    try {
      const res = await fetch(`/api/campaigns-v2/${id}`, { method: "DELETE" });
      if (res.ok) {
        setCampaigns((prev) => prev.filter((c) => (c.id as string) !== id));
      }
    } catch (err) {
      console.error("Delete failed:", err);
    } finally {
      setDeleting(false);
      setConfirmDeleteId(null);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 gap-2">
        <Loader2 size={20} className="animate-spin text-blue-500" />
        <span className="text-sm text-[var(--text-3)]">Loading campaigns...</span>
      </div>
    );
  }

  const activeCount = campaigns.filter((c) => (c.status as string) !== "archived").length;
  const runningCount = campaigns.filter((c) => (c.status as string) === "running").length;

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-6 gap-3">
        <div className="min-w-0">
          <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-1)] tracking-tight">Campaigns</h1>
          <p className="text-xs text-[var(--text-3)] mt-1">
            {activeCount} campaign{activeCount !== 1 ? "s" : ""}
            {runningCount > 0 && (
              <span className="text-emerald-400 ml-1.5">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse mr-1 align-middle" />
                {runningCount} running
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/campaigns/v1"
            className="flex items-center gap-1.5 px-3 py-2 border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] text-[var(--text-3)] hover:text-[var(--text-2)] text-xs font-medium rounded-lg transition-colors"
          >
            <Archive size={13} />
            <span className="hidden sm:inline">Legacy V1</span>
          </Link>
          <Link
            href="/campaigns/v2/new"
            className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors shadow-lg shadow-blue-600/25 flex-shrink-0"
          >
            <Plus size={15} />
            New Campaign
          </Link>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-6">
        <StatCard
          title="Contacts"
          value={totals.totalContacts.toLocaleString()}
          subtitle="all time"
          accent="text-indigo-400"
          icon={Users}
          iconColor="text-indigo-400"
          gradientFrom="from-indigo-500/[0.07]"
          gradientTo="to-transparent"
          chart={<BarChart data={sparkContacts}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(99,102,241,0.08)" }} /><Bar dataKey="v" fill="#818cf8" radius={[4,4,0,0]} /></BarChart>}
        />
        <StatCard
          title="Calls"
          value={totals.totalCalls.toLocaleString()}
          subtitle="last 7 days"
          accent="text-violet-400"
          icon={PhoneCall}
          iconColor="text-violet-400"
          gradientFrom="from-violet-500/[0.07]"
          gradientTo="to-transparent"
          chart={<BarChart data={sparkCalls}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(139,92,246,0.08)" }} /><Bar dataKey="v" fill="#a78bfa" radius={[4,4,0,0]} /></BarChart>}
        />
        <StatCard
          title="Connect Rate"
          value={totals.connectRate + "%"}
          subtitle="last 7 days"
          accent="text-emerald-400"
          icon={Zap}
          iconColor="text-emerald-400"
          gradientFrom="from-emerald-500/[0.07]"
          gradientTo="to-transparent"
          chart={<AreaChart data={sparkConnect}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} /><defs><linearGradient id="cgGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#34d399" stopOpacity={0.3}/><stop offset="95%" stopColor="#34d399" stopOpacity={0}/></linearGradient></defs><Area type="monotone" dataKey="v" stroke="#34d399" strokeWidth={2} fill="url(#cgGrad)" dot={false} /></AreaChart>}
        />
        <StatCard
          title="Success Rate"
          value={totals.successRate + "%"}
          subtitle="last 7 days"
          accent="text-amber-400"
          icon={Target}
          iconColor="text-amber-400"
          gradientFrom="from-amber-500/[0.07]"
          gradientTo="to-transparent"
          chart={<AreaChart data={sparkSuccess}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} /><defs><linearGradient id="srGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#fbbf24" stopOpacity={0.3}/><stop offset="95%" stopColor="#fbbf24" stopOpacity={0}/></linearGradient></defs><Area type="monotone" dataKey="v" stroke="#fbbf24" strokeWidth={2} fill="url(#srGrad)" dot={false} /></AreaChart>}
        />
      </div>

      {/* Search */}
      <div className="mb-4">
        <div className="relative w-full max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
          <input
            type="text"
            placeholder="Search campaigns..."
            value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-9 pr-8 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
          />
          {searchQuery && (
            <button onClick={() => handleSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)]">
              <X size={13} />
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        {campaigns.length === 0 ? (
          <div className="bg-[var(--bg-card)] px-6 py-20 text-center">
            <div className="w-14 h-14 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center mx-auto mb-4">
              <Plus size={22} className="text-blue-400" />
            </div>
            <p className="text-sm font-medium text-[var(--text-1)] mb-1">No campaigns yet</p>
            <p className="text-xs text-[var(--text-3)] mb-4">Create your first AI-powered outbound campaign</p>
            <Link href="/campaigns/v2/new" className="inline-flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-lg transition-colors">
              <Plus size={14} /> New Campaign
            </Link>
          </div>
        ) : (
          <>
            {/* Mobile cards */}
            <div className="md:hidden divide-y divide-[var(--border)] bg-[var(--bg-app)]">
              {paginated.map((c) => {
                const s = campaignStats[c.id as string] ?? { totalContacts: 0, totalCalls: 0, connectCount: 0, successCount: 0 };
                const connectRate = s.totalCalls > 0 ? ((s.connectCount / s.totalCalls) * 100).toFixed(1) + "%" : "0%";
                const hasActivity = s.totalCalls > 0;
                return (
                  <div
                    key={c.id as string}
                    onClick={() => router.push(`/campaigns/v2/${c.id}`)}
                    className={`px-4 py-3.5 cursor-pointer transition-colors hover:bg-[var(--bg-hover)] ${!hasActivity ? "opacity-60" : ""}`}
                  >
                    <div className="flex items-start justify-between gap-2 mb-2.5">
                      <div className="flex items-center gap-2 min-w-0 flex-1">
                        <div className="flex items-center gap-0.5 shrink-0">
                          <span className="w-5 h-5 rounded-md bg-blue-500/10 flex items-center justify-center">
                            <ArrowUpRight size={10} className="text-blue-400" />
                          </span>
                          <span className="w-5 h-5 rounded-md bg-[var(--bg-elevated)] flex items-center justify-center">
                            <Phone size={10} className="text-[var(--text-2)]" />
                          </span>
                        </div>
                        <span className="font-semibold text-[var(--text-1)] text-sm truncate">{c.name as string}</span>
                      </div>
                      <StatusBadge status={c.status as string} />
                    </div>
                    <div className="grid grid-cols-3 gap-3">
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Contacts</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{s.totalContacts.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Calls</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{s.totalCalls.toLocaleString()}</p>
                      </div>
                      <div>
                        <p className="text-[10px] text-[var(--text-3)] mb-0.5">Connect</p>
                        <p className="text-xs font-semibold text-[var(--text-2)]">{connectRate}</p>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Desktop table */}
            <div className="hidden md:block bg-[var(--bg-app)] w-full overflow-x-auto">
              <table className="w-full min-w-[740px] text-sm">
                <thead>
                  <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                    <th className="text-left px-5 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Campaign</th>
                    <th className="text-right px-4 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Contacts</th>
                    <th className="text-right px-4 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Calls</th>
                    <th className="text-right px-4 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Connect</th>
                    <th className="text-right px-4 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Success</th>
                    <th className="text-center px-4 py-3.5 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">Status</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {paginated.map((c, index) => {
                    const s = campaignStats[c.id as string] ?? { totalContacts: 0, totalCalls: 0, connectCount: 0, successCount: 0 };
                    const connectRate = s.totalCalls > 0 ? ((s.connectCount / s.totalCalls) * 100).toFixed(1) : "0";
                    const successRate = s.connectCount > 0 ? ((s.successCount / s.connectCount) * 100).toFixed(1) : "0";
                    const hasActivity = s.totalCalls > 0;
                    return (
                      <tr
                        key={c.id as string}
                        onClick={() => router.push(`/campaigns/v2/${c.id}`)}
                        className={`group border-b border-[var(--border)] last:border-b-0 hover:bg-blue-500/[0.04] transition-colors cursor-pointer ${!hasActivity ? "opacity-50 hover:opacity-80" : ""}`}
                      >
                        <td className="px-5 py-4">
                          <div className="flex items-center gap-3">
                            <div className="flex items-center gap-0.5 shrink-0">
                              <span className="w-7 h-7 rounded-lg bg-blue-500/10 flex items-center justify-center">
                                <ArrowUpRight size={13} className="text-blue-400" />
                              </span>
                              <span className="w-7 h-7 rounded-lg bg-[var(--bg-elevated)] flex items-center justify-center">
                                <Phone size={13} className="text-[var(--text-3)]" />
                              </span>
                            </div>
                            <div className="min-w-0">
                              <p className="font-semibold text-[var(--text-1)] group-hover:text-blue-400 transition-colors truncate">{c.name as string}</p>
                              {(c.vapi_assistant_name as string) && (
                                <p className="text-[11px] text-[var(--text-3)] mt-0.5 truncate">{c.vapi_assistant_name as string}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-4 text-right text-[var(--text-2)] tabular-nums">{s.totalContacts.toLocaleString()}</td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          <span className={hasActivity ? "text-blue-400 font-semibold" : "text-[var(--text-3)]"}>{s.totalCalls.toLocaleString()}</span>
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          <span className={`${Number(connectRate) > 0 ? "text-emerald-400" : "text-[var(--text-3)]"}`}>
                            {connectRate}%
                          </span>
                          <span className="text-[var(--text-3)] text-[11px] ml-1">({s.connectCount})</span>
                        </td>
                        <td className="px-4 py-4 text-right tabular-nums">
                          <span className={`${Number(successRate) > 0 ? "text-amber-400" : "text-[var(--text-3)]"}`}>
                            {successRate}%
                          </span>
                          <span className="text-[var(--text-3)] text-[11px] ml-1">({s.successCount})</span>
                        </td>
                        <td className="px-4 py-4 text-center"><StatusBadge status={c.status as string} /></td>
                        <td className="px-3 py-4" onClick={(e) => e.stopPropagation()}>
                          {(c.status as string) !== "running" && (
                            confirmDeleteId === (c.id as string) ? (
                              <span className="inline-flex items-center gap-2">
                                <button
                                  onClick={() => handleDelete(c.id as string)}
                                  disabled={deleting}
                                  className="text-[11px] text-red-400 hover:text-red-300 font-semibold disabled:opacity-50"
                                >
                                  {deleting ? "..." : "Yes"}
                                </button>
                                <button
                                  onClick={() => setConfirmDeleteId(null)}
                                  className="text-[11px] text-[var(--text-3)] hover:text-[var(--text-2)]"
                                >
                                  No
                                </button>
                              </span>
                            ) : (
                              <button
                                onClick={() => setConfirmDeleteId(c.id as string)}
                                className="opacity-0 group-hover:opacity-100 p-1 text-[var(--text-3)] hover:text-red-400 rounded-md hover:bg-red-500/10 transition-all"
                                title="Delete campaign"
                              >
                                <Trash2 size={14} />
                              </button>
                            )
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </>
        )}
        <div className="border-t border-[var(--border)] bg-[var(--bg-card)] px-5 py-3">
          <Pagination
            currentPage={safePage}
            totalPages={totalPages}
            totalItems={filtered.length}
            pageSize={PAGE_SIZE}
            onPageChange={setCurrentPage}
          />
        </div>
      </div>
    </div>
  );
}
