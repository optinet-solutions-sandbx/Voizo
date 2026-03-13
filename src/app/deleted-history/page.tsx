"use client";

import { useState, useEffect, useMemo } from "react";
import { Trash2, RotateCcw, Search, X, Megaphone, BookOpen, PhoneOff } from "lucide-react";
import { useToast } from "@/lib/toastContext";
import { fetchArchivedCampaigns, recoverCampaign, deleteCampaign } from "@/lib/campaignData";
import { fetchArchivedKnowledgeBases, restoreKnowledgeBase, deleteKnowledgeBase } from "@/lib/knowledgeBaseData";
import { fetchArchivedDncEntries, restoreDncEntry, deleteDncEntry } from "@/lib/dncData";

type ItemType = "Campaign" | "Knowledge Base" | "DNC";
type FilterType = "All" | ItemType;

interface DeletedItem {
  id: number;
  name: string;
  type: ItemType;
}

const TYPE_META: Record<ItemType, { icon: React.ElementType; color: string; bg: string; border: string }> = {
  "Campaign":       { icon: Megaphone, color: "text-blue-400",   bg: "bg-blue-500/10",   border: "border-blue-500/20"   },
  "Knowledge Base": { icon: BookOpen,  color: "text-indigo-400", bg: "bg-indigo-500/10", border: "border-indigo-500/20" },
  "DNC":            { icon: PhoneOff,  color: "text-red-400",    bg: "bg-red-500/10",    border: "border-red-500/20"    },
};

export default function DeletedHistoryPage() {
  const { showToast } = useToast();
  const [items, setItems] = useState<DeletedItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<FilterType>("All");
  const [confirmDelete, setConfirmDelete] = useState<DeletedItem | null>(null);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  async function loadAll() {
    setLoading(true);
    try {
      const [campaigns, kbs, dncs] = await Promise.all([
        fetchArchivedCampaigns(),
        fetchArchivedKnowledgeBases(),
        fetchArchivedDncEntries(),
      ]);
      const merged: DeletedItem[] = [
        ...campaigns.map((c) => ({ id: c.id, name: c.name, type: "Campaign" as ItemType })),
        ...kbs.map((k) => ({ id: k.id, name: k.name, type: "Knowledge Base" as ItemType })),
        ...dncs.map((d) => ({ id: d.id, name: d.phoneNumber, type: "DNC" as ItemType })),
      ];
      setItems(merged);
    } catch {
      showToast("Failed to load deleted history.", "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadAll(); }, []);

  async function handleRecover(item: DeletedItem) {
    setActionLoading(item.id);
    try {
      if (item.type === "Campaign")       await recoverCampaign(item.id);
      if (item.type === "Knowledge Base") await restoreKnowledgeBase(item.id);
      if (item.type === "DNC")            await restoreDncEntry(item.id);
      setItems((prev) => prev.filter((i) => !(i.id === item.id && i.type === item.type)));
      showToast(`"${item.name}" recovered successfully.`);
    } catch {
      showToast("Failed to recover item.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleDeletePermanently(item: DeletedItem) {
    setActionLoading(item.id);
    try {
      if (item.type === "Campaign")       await deleteCampaign(item.id);
      if (item.type === "Knowledge Base") await deleteKnowledgeBase(item.id);
      if (item.type === "DNC")            await deleteDncEntry(item.id);
      setItems((prev) => prev.filter((i) => !(i.id === item.id && i.type === item.type)));
      setConfirmDelete(null);
      showToast(`"${item.name}" permanently deleted.`, "error");
    } catch {
      showToast("Failed to delete item.", "error");
    } finally {
      setActionLoading(null);
    }
  }

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return items.filter((i) => {
      const matchType = filter === "All" || i.type === filter;
      const matchSearch = !q || i.name.toLowerCase().includes(q);
      return matchType && matchSearch;
    });
  }, [items, search, filter]);

  const counts: Record<FilterType, number> = {
    All: items.length,
    Campaign: items.filter((i) => i.type === "Campaign").length,
    "Knowledge Base": items.filter((i) => i.type === "Knowledge Base").length,
    DNC: items.filter((i) => i.type === "DNC").length,
  };

  const filters: FilterType[] = ["All", "Campaign", "Knowledge Base", "DNC"];

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <div className="w-9 h-9 rounded-lg bg-rose-500/10 border border-rose-500/20 flex items-center justify-center flex-shrink-0">
          <Trash2 size={17} className="text-rose-400" />
        </div>
        <div>
          <h1 className="text-lg sm:text-xl font-bold text-[var(--text-1)]">Deleted History</h1>
          <p className="text-xs text-[var(--text-3)] mt-0.5">{items.length} archived item{items.length !== 1 ? "s" : ""}</p>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-5 overflow-x-auto">
        {filters.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 whitespace-nowrap transition-colors ${
              filter === f ? "border-blue-500 text-blue-400" : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}>
            {f}
            {counts[f] > 0 && (
              <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                filter === f ? "bg-blue-500/20 text-blue-400" : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
              }`}>{counts[f]}</span>
            )}
          </button>
        ))}
      </div>

      {/* Search */}
      {items.length > 0 && (
        <div className="mb-4 relative max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
          <input type="text" value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Search deleted items…"
            className="w-full pl-8 pr-8 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
          />
          {search && (
            <button onClick={() => setSearch("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)]">
              <X size={13} />
            </button>
          )}
        </div>
      )}

      {/* Content */}
      {loading ? (
        <div className="flex items-center justify-center py-24 gap-2">
          <div className="w-4 h-4 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm text-[var(--text-3)]">Loading…</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-24 gap-2">
          <div className="w-12 h-12 rounded-full bg-[var(--bg-card)] flex items-center justify-center mb-1">
            <Trash2 size={20} className="text-[var(--text-3)]" />
          </div>
          <p className="text-sm text-[var(--text-2)] font-medium">
            {search ? `No results for "${search}"` : "No deleted items"}
          </p>
          {!search && <p className="text-xs text-[var(--text-3)]">Archived items will appear here</p>}
        </div>
      ) : (
        <>
          {/* Mobile cards */}
          <div className="sm:hidden space-y-3">
            {filtered.map((item) => {
              const meta = TYPE_META[item.type];
              const Icon = meta.icon;
              const isLoading = actionLoading === item.id;
              return (
                <div key={`${item.type}-${item.id}`} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4">
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${meta.bg} border ${meta.border}`}>
                      <Icon size={14} className={meta.color} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-[var(--text-1)] truncate">{item.name}</p>
                      <span className={`inline-block mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full ${meta.bg} ${meta.color}`}>{item.type}</span>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => handleRecover(item)} disabled={isLoading}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-40">
                      <RotateCcw size={12} /> Recover
                    </button>
                    <button onClick={() => setConfirmDelete(item)} disabled={isLoading}
                      className="flex-1 flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-40">
                      <Trash2 size={12} /> Delete
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Desktop table */}
          <div className="hidden sm:block bg-[var(--bg-app)] border border-[var(--border)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Name</th>
                  <th className="text-left px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide w-40">Type</th>
                  <th className="text-right px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide w-56">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, index) => {
                  const meta = TYPE_META[item.type];
                  const Icon = meta.icon;
                  const isLoading = actionLoading === item.id;
                  return (
                    <tr key={`${item.type}-${item.id}`}
                      className={`transition-colors hover:bg-[var(--bg-hover)] ${index < filtered.length - 1 ? "border-b border-[var(--border)]" : ""}`}>
                      <td className="px-6 py-4">
                        <div className="flex items-center gap-3">
                          <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${meta.bg} border ${meta.border}`}>
                            <Icon size={13} className={meta.color} />
                          </div>
                          <span className="font-medium text-[var(--text-1)]">{item.name}</span>
                        </div>
                      </td>
                      <td className="px-6 py-4">
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold ${meta.bg} ${meta.color} border ${meta.border}`}>
                          {item.type}
                        </span>
                      </td>
                      <td className="px-6 py-4">
                        <div className="flex items-center justify-end gap-2">
                          <button onClick={() => handleRecover(item)} disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-blue-500/10 text-blue-400 border border-blue-500/20 hover:bg-blue-500/20 transition-colors disabled:opacity-40">
                            <RotateCcw size={12} /> Recover
                          </button>
                          <button onClick={() => setConfirmDelete(item)} disabled={isLoading}
                            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-colors disabled:opacity-40">
                            <Trash2 size={12} /> Delete Permanently
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <div className="px-6 py-2.5 border-t border-[var(--border)] bg-[var(--bg-card)]">
              <p className="text-xs text-[var(--text-3)]">{filtered.length} item{filtered.length !== 1 ? "s" : ""}</p>
            </div>
          </div>
        </>
      )}

      {/* Delete confirmation modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <Trash2 size={20} className="text-red-400" />
            </div>
            <h2 className="text-base font-semibold text-[var(--text-1)] mb-2">Delete permanently?</h2>
            <p className="text-sm text-[var(--text-2)] mb-1 leading-relaxed">
              <span className="font-medium text-[var(--text-1)]">&ldquo;{confirmDelete.name}&rdquo;</span> will be removed forever.
            </p>
            <p className="text-xs text-red-400 mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setConfirmDelete(null)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={() => handleDeletePermanently(confirmDelete)} disabled={actionLoading !== null}
                className="flex-1 px-4 py-2.5 bg-red-500/90 hover:bg-red-500 text-white rounded-full text-sm font-medium transition-colors disabled:opacity-40">
                {actionLoading !== null ? "Deleting…" : "Delete"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
