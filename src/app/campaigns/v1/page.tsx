"use client";

import React, { useState, useMemo, useEffect } from "react";
import Link from "next/link";
import { useNotifications } from "@/lib/notificationsContext";
import { Search, Plus, X, Megaphone as MegaphoneIcon, Sparkles } from "lucide-react";
import {
  AreaChart, Area, BarChart, Bar, ResponsiveContainer, Tooltip, XAxis
} from "recharts";

// Generate last N day labels e.g. "Mar 5"
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
      <p className="text-[var(--text-2)]">{pct}% of month</p>
    </div>
  );
}
import CampaignsTable from "@/components/CampaignsTable";
import CampaignEditor from "@/components/CampaignEditor";
import AddGroupModal from "@/components/AddGroupModal";
import Pagination from "@/components/Pagination";
import { fetchCampaigns, insertCampaign, deleteCampaign, archiveCampaign, recoverCampaign, Campaign, Group } from "@/lib/campaignData";
import { useToast } from "@/lib/toastContext";

const BUILTIN_GROUPS: Group[] = ["Canada", "RND", "Reactivation", "Archived"];
const PAGE_SIZE = 5;

export default function CampaignsPage() {
  const { addNotification } = useNotifications();
  const { showToast } = useToast();
  const [campaigns, setCampaigns] = useState<Campaign[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchCampaigns()
      .then((camps) => {
        setCampaigns(camps);
      })
      .finally(() => setLoading(false));
  }, []);
  const [customGroups, setCustomGroups] = useState<Group[]>([]);
  const [activeTab, setActiveTab] = useState<string>("All");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [showNewModal, setShowNewModal] = useState(false);
  const [showAddGroupModal, setShowAddGroupModal] = useState(false);
  const [deleteGroupConfirm, setDeleteGroupConfirm] = useState<string | null>(null);

  const allGroups = useMemo(() => [...BUILTIN_GROUPS, ...customGroups], [customGroups]);

  const filtered = useMemo(() => {
    let list = campaigns;
    if (activeTab === "All") list = list.filter((c) => c.group !== "Archived");
    else list = list.filter((c) => c.group === activeTab);
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      list = list.filter((c) => c.name.toLowerCase().includes(q));
    }
    return list;
  }, [campaigns, activeTab, searchQuery]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const safePage = Math.min(currentPage, totalPages);
  const paginated = filtered.slice((safePage - 1) * PAGE_SIZE, safePage * PAGE_SIZE);

  const tabCounts = useMemo(() => {
    const counts: Record<string, number> = { All: campaigns.filter((c) => c.group !== "Archived").length };
    for (const g of allGroups) {
      counts[g] = campaigns.filter((c) => c.group === g).length;
    }
    return counts;
  }, [campaigns, allGroups]);

  const stats = useMemo(() => {
    const totalContacts = filtered.reduce((s, c) => s + c.totalContacts, 0);
    const totalCalls = filtered.reduce((s, c) => s + c.totalCalls, 0);
    const totalConnect = filtered.reduce((s, c) => s + c.connectCount, 0);
    const totalSuccess = filtered.reduce((s, c) => s + c.successCount, 0);
    const connectRate = totalCalls > 0 ? ((totalConnect / totalCalls) * 100).toFixed(1) : "0";
    const successRate = totalConnect > 0 ? ((totalSuccess / totalConnect) * 100).toFixed(1) : "0";
    return { totalContacts, totalCalls, connectRate, successRate };
  }, [filtered]);

  // Sparkline data derived from campaigns (last 7 data points)
  const sparkContacts = useMemo(() => {
    const pts = filtered.slice(-7).map((c) => c.totalContacts);
    const total = pts.reduce((s, v) => s + v, 0) || 1;
    return pts.map((v, i) => ({ i, v, date: DAY_LABELS[i], pct: Math.round((v / total) * 100) }));
  }, [filtered]);
  const sparkCalls = useMemo(() => {
    const pts = filtered.slice(-7).map((c) => c.totalCalls);
    const total = pts.reduce((s, v) => s + v, 0) || 1;
    return pts.map((v, i) => ({ i, v, date: DAY_LABELS[i], pct: Math.round((v / total) * 100) }));
  }, [filtered]);
  const sparkConnect = useMemo(() => {
    const pts = filtered.slice(-7).map((c) => c.totalCalls > 0 ? Math.round((c.connectCount / c.totalCalls) * 100) : 0);
    const total = pts.reduce((s, v) => s + v, 0) || 1;
    return pts.map((v, i) => ({ i, v, date: DAY_LABELS[i], pct: Math.round((v / total) * 100) }));
  }, [filtered]);
  const sparkSuccess = useMemo(() => {
    const pts = filtered.slice(-7).map((c) => c.connectCount > 0 ? Math.round((c.successCount / c.connectCount) * 100) : 0);
    const total = pts.reduce((s, v) => s + v, 0) || 1;
    return pts.map((v, i) => ({ i, v, date: DAY_LABELS[i], pct: Math.round((v / total) * 100) }));
  }, [filtered]);

  function handleTabChange(tab: string) { setActiveTab(tab); setCurrentPage(1); }
  function handleSearch(q: string) { setSearchQuery(q); setCurrentPage(1); }

  async function handleAddCampaign(campaign: Campaign) {
    try {
      const saved = await insertCampaign(campaign);
      setCampaigns((prev) => [saved, ...prev]);
      addNotification(`New campaign added: "${saved.name}"`);
      showToast(`Campaign "${saved.name}" added successfully!`);
      setShowNewModal(false);
      setActiveTab(campaign.group);
      setSearchQuery("");
      setCurrentPage(1);
    } catch (err) {
      console.error("Failed to save campaign:", err);
      showToast("Failed to save campaign. Please try again.");
    }
  }

  function handleAddGroup(name: string) {
    if (!allGroups.includes(name)) setCustomGroups((prev) => [...prev, name]);
    setActiveTab(name);
    setCurrentPage(1);
    setShowAddGroupModal(false);
  }

  function handleDeleteGroup(name: string) {
    setCustomGroups((prev) => prev.filter((g) => g !== name));
    if (activeTab === name) setActiveTab("All");
    setCurrentPage(1);
    setDeleteGroupConfirm(null);
  }

  function handleDuplicateCampaign(id: number) {
    const src = campaigns.find((c) => c.id === id);
    if (!src) return;
    const newId = Math.max(...campaigns.map((c) => c.id)) + 1;
    setCampaigns((prev) => [
      { ...src, id: newId, name: src.name + " (Copy)", isDuplicate: true },
      ...prev,
    ]);
  }

  async function handleDeleteCampaign(id: number) {
    setCampaigns((prev) => prev.filter((c) => c.id !== id));
    try { await deleteCampaign(id); } catch { /* already removed from UI */ }
  }

  async function handleArchiveCampaign(id: number) {
    setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, group: "Archived" } : c));
    try { await archiveCampaign(id); } catch { /* already updated in UI */ }
  }

  async function handleRecoverCampaign(id: number) {
    setCampaigns((prev) => prev.map((c) => c.id === id ? { ...c, group: "RND" } : c));
    try { await recoverCampaign(id); } catch { /* already updated in UI */ }
  }

  const tabs = [{ label: "All", group: "All" }, ...allGroups.map((g) => ({ label: g, group: g }))];

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-6 w-full">

      {/* ── Page header ── */}
      <div className="flex items-start sm:items-center justify-between mb-5 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-blue-500/10 border border-blue-500/20 flex items-center justify-center flex-shrink-0">
            <MegaphoneIcon size={17} className="text-blue-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-[var(--text-1)]">Campaigns</h1>
            <p className="text-xs text-[var(--text-3)] mt-0.5">{campaigns.filter((c) => c.group !== "Archived").length} active campaigns</p>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Link
            href="/campaigns/v2/new"
            className="flex items-center gap-2 px-3 sm:px-4 py-2 border border-[var(--border)] bg-[var(--bg-card)] hover:bg-[var(--bg-elevated)] text-[var(--text-2)] text-sm font-medium rounded-full transition-colors"
          >
            <Sparkles size={15} />
            <span className="hidden sm:inline">New Campaign V2</span>
            <span className="sm:hidden">V2</span>
          </Link>
          <button
            onClick={() => { setShowNewModal(true); }}
            className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-full transition-colors shadow-md shadow-blue-600/20 flex-shrink-0"
          >
            <Plus size={15} />
            <span className="hidden sm:inline">New Campaign</span>
            <span className="sm:hidden">New</span>
          </button>
        </div>
      </div>

      {/* ── Tab bar ── */}
      <div className="mb-5 border-b border-[var(--border)] overflow-x-auto hide-scrollbar">
        <div className="flex items-center min-w-max">
          {tabs.map((tab) => {
            const isDeletable = tab.group !== "All";
            const isActive = activeTab === tab.group;
            return (
              <div key={tab.group} className="group relative flex items-center">
                <button
                  onClick={() => handleTabChange(tab.group)}
                  className={`flex items-center gap-1.5 py-2.5 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                    isDeletable ? "pl-3 sm:pl-4 pr-1" : "px-3 sm:px-4"
                  } ${
                    isActive
                      ? "border-blue-500 text-blue-400"
                      : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)] hover:border-[var(--border-2)]"
                  }`}
                >
                  {tab.label}
                  <span className={`inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-xs font-medium ${
                    isActive ? "bg-blue-500/20 text-blue-400" : "bg-[var(--bg-elevated)] text-[var(--text-2)]"
                  }`}>
                    {tabCounts[tab.group] ?? 0}
                  </span>
                </button>
                {isDeletable && (
                  <button onClick={() => setDeleteGroupConfirm(tab.group)}
                    className="opacity-0 group-hover:opacity-100 transition-opacity ml-0.5 mr-2 p-0.5 rounded-full hover:bg-[var(--bg-elevated)] text-[var(--text-3)] hover:text-[var(--text-2)] -mb-px"
                    title={`Remove ${tab.label}`}>
                    <X size={12} />
                  </button>
                )}
              </div>
            );
          })}
          <button onClick={() => setShowAddGroupModal(true)}
            className="flex items-center gap-1 px-3 sm:px-4 py-2.5 text-sm font-medium text-[var(--text-3)] hover:text-[var(--text-2)] transition-colors border-b-2 border-transparent -mb-px whitespace-nowrap">
            <Plus size={13} />
            Add Group
          </button>
        </div>
      </div>

      {/* ── Stats ── 2 cols mobile / 4 cols desktop (hidden on Archived tab) */}
      <div className={`grid grid-cols-2 sm:grid-cols-4 gap-3 sm:gap-4 mb-5 ${activeTab === "Archived" ? "hidden" : ""}`}>
        {/* Total Contacts */}
        <StatCard
          title="Total Contacts"
          value={stats.totalContacts.toLocaleString()}
          change={+13}
          label="this month"
          chart={<BarChart data={sparkContacts}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(99,102,241,0.08)" }} /><Bar dataKey="v" fill="#6366f1" radius={[3,3,0,0]} /></BarChart>}
        />
        {/* Total Calls */}
        <StatCard
          title="Total Calls"
          value={stats.totalCalls.toLocaleString()}
          change={+8}
          label="this month"
          chart={<BarChart data={sparkCalls}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} cursor={{ fill: "rgba(139,92,246,0.08)" }} /><Bar dataKey="v" fill="#8b5cf6" radius={[3,3,0,0]} /></BarChart>}
        />
        {/* Connect Rate */}
        <StatCard
          title="Connect Rate"
          value={stats.connectRate + "%"}
          change={+5}
          label="this month"
          chart={<AreaChart data={sparkConnect}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} /><defs><linearGradient id="cgGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#22c55e" stopOpacity={0.25}/><stop offset="95%" stopColor="#22c55e" stopOpacity={0}/></linearGradient></defs><Area type="monotone" dataKey="v" stroke="#22c55e" strokeWidth={2} fill="url(#cgGrad)" dot={false} /></AreaChart>}
        />
        {/* Success Rate */}
        <StatCard
          title="Success Rate"
          value={stats.successRate + "%"}
          change={-2}
          label="this month"
          chart={<AreaChart data={sparkSuccess}><XAxis dataKey="i" hide /><Tooltip content={<ChartTooltip />} /><defs><linearGradient id="srGrad" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="#f59e0b" stopOpacity={0.25}/><stop offset="95%" stopColor="#f59e0b" stopOpacity={0}/></linearGradient></defs><Area type="monotone" dataKey="v" stroke="#f59e0b" strokeWidth={2} fill="url(#srGrad)" dot={false} /></AreaChart>}
        />
      </div>

      {/* ── Search ── */}
      <div className="mb-4">
        <div className="relative w-full max-w-md">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
          <input type="text" placeholder="Search Campaigns" value={searchQuery}
            onChange={(e) => handleSearch(e.target.value)}
            className="w-full pl-9 pr-4 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
          />
        </div>
      </div>

      {/* ── Table + Pagination ── */}
      <div className="rounded-xl border border-[var(--border)] overflow-hidden">
        <CampaignsTable campaigns={paginated} onDuplicate={handleDuplicateCampaign} onDelete={handleDeleteCampaign} onArchive={handleArchiveCampaign} onRecover={handleRecoverCampaign} />
        <div className="border-t border-[var(--border)] bg-[var(--bg-card)] px-4 py-3">
          <Pagination currentPage={safePage} totalPages={totalPages} totalItems={filtered.length} pageSize={PAGE_SIZE} onPageChange={setCurrentPage} />
        </div>
      </div>

      {/* Full campaign editor */}
      {showNewModal && (
        <CampaignEditor
          onClose={() => setShowNewModal(false)}
          onSave={handleAddCampaign}
          nextId={campaigns.length + 1}
          availableGroups={allGroups}
        />
      )}
      {showAddGroupModal && (
        <AddGroupModal
          onClose={() => setShowAddGroupModal(false)}
          onAdd={handleAddGroup}
        />
      )}

      {/* ── Delete group confirmation modal ── */}
      {deleteGroupConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <h2 className="text-base font-semibold text-[var(--text-1)] mb-1">Delete Group</h2>
            <p className="text-sm text-[var(--text-2)] mb-6">
              Are you sure you want to delete the <span className="font-medium text-[var(--text-1)]">{deleteGroupConfirm}</span> group?
            </p>
            <div className="flex gap-3 justify-end">
              <button onClick={() => setDeleteGroupConfirm(null)}
                className="px-4 py-2 text-sm font-medium text-[var(--text-2)] bg-[var(--bg-elevated)] hover:bg-[var(--border-2)] rounded-lg transition-colors">
                No
              </button>
              <button onClick={() => handleDeleteGroup(deleteGroupConfirm)}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500/90 hover:bg-red-500 rounded-lg transition-colors">
                Yes, Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── StatCard component ──────────────────────────────────────────────────────

interface StatCardProps {
  title: string;
  value: string;
  change: number;
  label: string;
  chart: React.ReactNode;
}

function StatCard({ title, value, change, label, chart }: StatCardProps) {
  const isPositive = change >= 0;
  return (
    <div className="bg-[var(--bg-card)] rounded-xl border border-[var(--border)] p-4 flex flex-col gap-3 overflow-hidden">
      <p className="text-xs font-semibold text-[var(--text-2)] truncate">{title}</p>
      <div className="h-14 sm:h-16 w-full">
        <ResponsiveContainer width="100%" height="100%">
          {chart as React.ReactElement}
        </ResponsiveContainer>
      </div>
      <div className="flex items-end justify-between gap-2">
        <p className="text-xl sm:text-2xl font-bold text-[var(--text-1)] leading-tight tracking-tight">{value}</p>
        <div className="flex flex-col items-end shrink-0">
          <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-full ${
            isPositive ? "bg-emerald-500/10 text-emerald-400" : "bg-red-500/10 text-red-400"
          }`}>
            {isPositive ? "↑" : "↓"}{Math.abs(change)}%
          </span>
          <span className="text-[10px] text-[var(--text-3)] mt-0.5 text-right">{label}</span>
        </div>
      </div>
    </div>
  );
}
