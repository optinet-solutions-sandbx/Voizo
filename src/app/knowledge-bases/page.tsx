"use client";

import { useState, useMemo } from "react";
import { Plus, X, Trash2, BookOpen, Archive, RotateCcw, Search } from "lucide-react";
import { useToast } from "@/lib/toastContext";
import { useNotifications } from "@/lib/notificationsContext";

interface KnowledgeBase {
  id: number;
  name: string;
  dataSources: number;
  dateOfCreation: string;
  archived: boolean;
}

const initialKnowledgeBases: KnowledgeBase[] = [
  { id: 1, name: "Lucky 7 RND campaign", dataSources: 10, dateOfCreation: "Nov 6, 2025", archived: false },
  { id: 2, name: "Lucky7even (FAQ / Objection Handling)", dataSources: 0, dateOfCreation: "Nov 11, 2025", archived: false },
  { id: 3, name: "Test", dataSources: 0, dateOfCreation: "Feb 4, 2026", archived: false },
];

function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function KnowledgeBasesPage() {
  const { showToast } = useToast();
  const { addNotification } = useNotifications();
  const [items, setItems] = useState<KnowledgeBase[]>(initialKnowledgeBases);
  const [showModal, setShowModal] = useState(false);
  const [newName, setNewName] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<number | null>(null);
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [searchQuery, setSearchQuery] = useState("");

  function handleCreate() {
    if (!newName.trim()) return;
    const name = newName.trim();
    setItems((prev) => [{ id: Date.now(), name, dataSources: 0, dateOfCreation: formatDate(new Date()), archived: false }, ...prev]);
    setNewName("");
    setShowModal(false);
    const msg = `Knowledge base "${name}" created successfully!`;
    showToast(msg);
    addNotification(msg);
  }

  function handleArchive(id: number) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, archived: true } : i));
    showToast("Knowledge base moved to archive.");
  }

  function handleRestore(id: number) {
    setItems((prev) => prev.map((i) => i.id === id ? { ...i, archived: false } : i));
    showToast("Knowledge base restored.");
  }

  function handleDelete(id: number) {
    const item = items.find((i) => i.id === id);
    setItems((prev) => prev.filter((i) => i.id !== id));
    setDeleteConfirmId(null);
    if (item) showToast(`"${item.name}" permanently deleted.`, "error");
  }

  const activeItems = useMemo(() => items.filter((i) => !i.archived), [items]);
  const archivedItems = useMemo(() => items.filter((i) => i.archived), [items]);
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = tab === "active" ? activeItems : archivedItems;
    if (!q) return list;
    return list.filter((i) => i.name.toLowerCase().includes(q));
  }, [tab, activeItems, archivedItems, searchQuery]);

  const deleteTarget = items.find((i) => i.id === deleteConfirmId);

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center flex-shrink-0">
            <BookOpen size={17} className="text-indigo-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-[var(--text-1)]">Knowledge Bases</h1>
            <p className="text-xs text-[var(--text-3)] mt-0.5">{activeItems.length} active · {archivedItems.length} archived</p>
          </div>
        </div>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-full transition-colors shadow-md shadow-blue-600/20 flex-shrink-0">
          <Plus size={15} />
          <span className="hidden sm:inline">Create New</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-5">
        {(["active", "archived"] as const).map((t) => {
          const count = t === "active" ? activeItems.length : archivedItems.length;
          return (
            <button key={t} onClick={() => { setTab(t); setSearchQuery(""); }}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors ${
                tab === t ? "border-blue-500 text-blue-400" : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)]"
              }`}>
              {t === "archived" && <Archive size={13} />}
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {count > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  tab === t ? "bg-blue-500/20 text-blue-400" : "bg-[var(--bg-elevated)] text-[var(--text-3)]"
                }`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Search */}
      {(tab === "active" ? activeItems : archivedItems).length > 0 && (
        <div className="mb-4 relative max-w-xs">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
          <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search knowledge bases…"
            className="w-full pl-8 pr-8 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
          />
          {searchQuery && (
            <button onClick={() => setSearchQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)]"><X size={13} /></button>
          )}
        </div>
      )}

      {/* Mobile cards */}
      <div className="sm:hidden space-y-3">
        {filtered.length === 0 && searchQuery ? (
          <p className="text-[var(--text-3)] text-sm text-center py-12">No results for &ldquo;{searchQuery}&rdquo;</p>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <div className="w-12 h-12 rounded-full bg-[var(--bg-card)] flex items-center justify-center mb-1">
              {tab === "active" ? <BookOpen size={20} className="text-[var(--text-3)]" /> : <Archive size={20} className="text-[var(--text-3)]" />}
            </div>
            <p className="text-sm text-[var(--text-3)]">{tab === "active" ? "No knowledge bases yet" : "No archived knowledge bases"}</p>
          </div>
        ) : filtered.map((item) => (
          <div key={item.id} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl p-4 hover:border-[var(--border-2)] transition-colors">
            <div className="flex items-start justify-between gap-2">
              <p className={`font-semibold text-sm mb-2 ${tab === "archived" ? "text-[var(--text-3)] line-through" : "text-[var(--text-1)]"}`}>{item.name}</p>
              <div className="flex gap-1 flex-shrink-0">
                {tab === "active" ? (
                  <button onClick={() => handleArchive(item.id)} className="p-1.5 text-[var(--text-3)] hover:text-amber-400 hover:bg-amber-500/10 rounded-md transition-colors" title="Archive"><Archive size={13} /></button>
                ) : (
                  <>
                    <button onClick={() => handleRestore(item.id)} className="p-1.5 text-[var(--text-3)] hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors" title="Restore"><RotateCcw size={13} /></button>
                    <button onClick={() => setDeleteConfirmId(item.id)} className="p-1.5 text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors" title="Delete"><Trash2 size={13} /></button>
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center justify-between text-xs text-[var(--text-3)]">
              <span>{item.dataSources} data source{item.dataSources !== 1 ? "s" : ""}</span>
              <span>{item.dateOfCreation}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Desktop table */}
      <div className="hidden sm:block">
        {filtered.length === 0 && searchQuery ? (
          <div className="flex flex-col items-center justify-center py-20 gap-2">
            <p className="text-sm text-[var(--text-3)]">No results for &ldquo;{searchQuery}&rdquo;</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 gap-2">
            <div className="w-12 h-12 rounded-full bg-[var(--bg-card)] flex items-center justify-center mb-1">
              {tab === "active" ? <BookOpen size={20} className="text-[var(--text-3)]" /> : <Archive size={20} className="text-[var(--text-3)]" />}
            </div>
            <p className="text-sm text-[var(--text-3)]">{tab === "active" ? "No knowledge bases yet" : "No archived knowledge bases"}</p>
            {tab === "active" && <p className="text-xs text-[var(--text-3)]">Create one to get started</p>}
          </div>
        ) : (
          <div className="bg-[var(--bg-app)] border border-[var(--border)] rounded-xl overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                  <th className="text-left px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide w-1/2">Knowledge Base</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Data Sources</th>
                  <th className="text-center px-6 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Created</th>
                  <th className="w-20 text-right px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item, index) => (
                  <tr key={item.id}
                    className={`hover:bg-[var(--bg-hover)] transition-colors cursor-pointer group ${index < filtered.length - 1 ? "border-b border-[var(--border)]" : ""}`}>
                    <td className="px-6 py-4">
                      <span className={`font-semibold ${tab === "archived" ? "text-[var(--text-3)] line-through" : "text-[var(--text-1)]"}`}>{item.name}</span>
                    </td>
                    <td className="px-6 py-4 text-center">
                      <span className="inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                        {item.dataSources}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-center text-[var(--text-3)] text-xs">{item.dateOfCreation}</td>
                    <td className="px-4 py-4">
                      <div className="flex items-center justify-end gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        {tab === "active" ? (
                          <button onClick={(e) => { e.stopPropagation(); handleArchive(item.id); }} title="Archive"
                            className="p-1.5 text-[var(--text-3)] hover:text-amber-400 hover:bg-amber-500/10 rounded-md transition-colors"><Archive size={13} /></button>
                        ) : (
                          <>
                            <button onClick={(e) => { e.stopPropagation(); handleRestore(item.id); }} title="Restore"
                              className="p-1.5 text-[var(--text-3)] hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors"><RotateCcw size={13} /></button>
                            <button onClick={(e) => { e.stopPropagation(); setDeleteConfirmId(item.id); }} title="Delete permanently"
                              className="p-1.5 text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors"><Trash2 size={13} /></button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="px-6 py-2.5 border-t border-[var(--border)] bg-[var(--bg-card)]">
              <p className="text-xs text-[var(--text-3)]">{filtered.length} knowledge base{filtered.length !== 1 ? "s" : ""}</p>
            </div>
          </div>
        )}
      </div>

      {/* Create modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setShowModal(false)} />
          <div className="relative bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6">
            <div className="flex items-center justify-between mb-5">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-lg bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
                  <BookOpen size={15} className="text-indigo-400" />
                </div>
                <h2 className="text-base font-semibold text-[var(--text-1)]">New Knowledge Base</h2>
              </div>
              <button onClick={() => setShowModal(false)} className="p-1 text-[var(--text-2)] hover:text-[var(--text-1)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"><X size={18} /></button>
            </div>
            <div className="mb-6">
              <label className="block text-xs font-medium text-[var(--text-2)] mb-1.5">Name</label>
              <input type="text" value={newName} onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="e.g. FAQ / Objection Handling" autoFocus
                className="w-full px-4 py-2.5 bg-[var(--bg-app)] border-2 border-blue-500 rounded-xl text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none"
              />
            </div>
            <div className="flex gap-3">
              <button onClick={() => setShowModal(false)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={handleCreate} disabled={!newName.trim()}
                className="flex-1 px-4 py-2.5 rounded-full text-sm font-medium transition-colors disabled:opacity-30 disabled:cursor-not-allowed bg-blue-600 hover:bg-blue-500 text-white shadow-md shadow-blue-600/20">
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete confirmation */}
      {deleteConfirmId && deleteTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm px-4">
          <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl w-full max-w-sm p-6 text-center">
            <div className="w-12 h-12 rounded-full bg-red-500/10 border border-red-500/20 flex items-center justify-center mx-auto mb-4">
              <Trash2 size={20} className="text-red-400" />
            </div>
            <h2 className="text-base font-semibold text-[var(--text-1)] mb-2">Delete permanently?</h2>
            <p className="text-sm text-[var(--text-2)] mb-1 leading-relaxed">
              <span className="font-medium text-[var(--text-1)]">&ldquo;{deleteTarget.name}&rdquo;</span> will be removed along with all data.
            </p>
            <p className="text-xs text-red-400 mb-6">This action cannot be undone.</p>
            <div className="flex gap-3">
              <button onClick={() => setDeleteConfirmId(null)}
                className="flex-1 px-4 py-2.5 border border-[var(--border)] rounded-full text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors">
                Cancel
              </button>
              <button onClick={() => handleDelete(deleteConfirmId)}
                className="flex-1 px-4 py-2.5 bg-red-500/90 hover:bg-red-500 text-white rounded-full text-sm font-medium transition-colors">
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
