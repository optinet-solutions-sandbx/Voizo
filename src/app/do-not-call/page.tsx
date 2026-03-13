"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { PhoneOff, Plus, X, Upload, Phone, Search, Loader2, AlertCircle, Archive, RotateCcw, Trash2 } from "lucide-react";
import { fetchDncEntries, insertDncEntries, archiveDncEntry, restoreDncEntry, deleteDncEntry, DncEntry } from "@/lib/dncData";
import { useToast } from "@/lib/toastContext";
import { useNotifications } from "@/lib/notificationsContext";

export default function DoNotCallPage() {
  const { showToast } = useToast();
  const { addNotification } = useNotifications();
  const [entries, setEntries] = useState<DncEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showModal, setShowModal] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [tab, setTab] = useState<"active" | "archived">("active");
  const [processingId, setProcessingId] = useState<number | null>(null);

  useEffect(() => { load(); }, []);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchDncEntries();
      setEntries(data);
    } finally {
      setLoading(false);
    }
  }

  async function handleAdd(numbers: string[]) {
    setShowModal(false);
    try {
      const added = await insertDncEntries(numbers);
      setEntries((prev) => {
        const existingIds = new Set(prev.map((e) => e.id));
        const fresh = added.filter((e) => !existingIds.has(e.id));
        return [...fresh, ...prev];
      });
      const count = added.length;
      const msg = count === 1 ? `1 phone number added to DNC list.` : `${count} phone numbers added to DNC list.`;
      showToast(msg);
      addNotification(msg);
    } catch {
      setError("Failed to add numbers. Please try again.");
      showToast("Failed to add numbers.", "error");
    }
  }

  async function handleArchive(id: number) {
    setProcessingId(id);
    try {
      await archiveDncEntry(id);
      setEntries((prev) => prev.map((e) => e.id === id ? { ...e, archived: true } : e));
      showToast("Number moved to archive.");
    } catch { setError("Failed to archive number."); }
    finally { setProcessingId(null); }
  }

  async function handleRestore(id: number) {
    setProcessingId(id);
    try {
      await restoreDncEntry(id);
      setEntries((prev) => prev.map((e) => e.id === id ? { ...e, archived: false } : e));
      showToast("Number restored to active list.");
    } catch { setError("Failed to restore number."); }
    finally { setProcessingId(null); }
  }

  async function handleDelete(id: number) {
    setProcessingId(id);
    try {
      await deleteDncEntry(id);
      setEntries((prev) => prev.filter((e) => e.id !== id));
      showToast("Number permanently deleted.", "error");
    } catch { setError("Failed to delete number."); }
    finally { setProcessingId(null); }
  }

  const activeEntries = useMemo(() => entries.filter((e) => !e.archived), [entries]);
  const archivedEntries = useMemo(() => entries.filter((e) => e.archived), [entries]);
  const filtered = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const list = tab === "active" ? activeEntries : archivedEntries;
    if (!q) return list;
    return list.filter((e) => e.phoneNumber.toLowerCase().includes(q));
  }, [tab, activeEntries, archivedEntries, searchQuery]);

  return (
    <div className="p-4 sm:p-6 w-full">
      {/* Header */}
      <div className="flex items-start sm:items-center justify-between mb-6 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-lg bg-red-500/10 border border-red-500/20 flex items-center justify-center flex-shrink-0">
            <PhoneOff size={17} className="text-red-400" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg sm:text-xl font-bold text-[var(--text-1)] truncate">Do Not Call List</h1>
            <p className="text-xs text-[var(--text-3)] mt-0.5">{activeEntries.length} active · {archivedEntries.length} archived</p>
          </div>
        </div>
        <button onClick={() => setShowModal(true)}
          className="flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium rounded-full transition-colors shadow-md shadow-blue-600/20 flex-shrink-0">
          <Plus size={15} />
          <span className="hidden sm:inline">Add Phone Numbers</span>
          <span className="sm:hidden">Add</span>
        </button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] mb-5">
        {(["active", "archived"] as const).map((t) => {
          const count = t === "active" ? activeEntries.length : archivedEntries.length;
          return (
            <button key={t} onClick={() => { setTab(t); setSearchQuery(""); }}
              className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors capitalize ${
                tab === t ? "border-blue-500 text-blue-400" : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)]"
              }`}>
              {t === "archived" && <Archive size={13} />}
              {t.charAt(0).toUpperCase() + t.slice(1)}
              {count > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  tab === t ? "bg-blue-500/20 text-blue-400" : "bg-[var(--bg-elevated)] text-[var(--text-2)]"
                }`}>{count}</span>
              )}
            </button>
          );
        })}
      </div>

      {/* Error */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 mb-4 bg-red-500/10 border border-red-500/20 rounded-xl text-red-400 text-sm">
          <AlertCircle size={15} className="flex-shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)} className="text-red-500 hover:text-red-300"><X size={14} /></button>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-24 gap-3">
          <Loader2 size={24} className="text-blue-500 animate-spin" />
          <p className="text-sm text-[var(--text-3)]">Loading DNC list…</p>
        </div>
      ) : (
        <>
          {/* Search */}
          {(tab === "active" ? activeEntries : archivedEntries).length > 0 && (
            <div className="mb-4 relative max-w-xs">
              <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
              <input type="text" value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="Search phone numbers…"
                className="w-full pl-8 pr-8 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
              />
              {searchQuery && (
                <button onClick={() => setSearchQuery("")} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)]"><X size={13} /></button>
              )}
            </div>
          )}

          {/* Empty states */}
          {filtered.length === 0 && searchQuery ? (
            <div className="flex flex-col items-center justify-center py-16 gap-2">
              <p className="text-sm text-[var(--text-3)]">No results for &ldquo;{searchQuery}&rdquo;</p>
            </div>
          ) : filtered.length === 0 && tab === "active" ? (
            <div className="flex flex-col items-center justify-center py-24 gap-2">
              <div className="w-12 h-12 rounded-full bg-[var(--bg-card)] flex items-center justify-center mb-1">
                <PhoneOff size={20} className="text-[var(--text-3)]" />
              </div>
              <p className="text-sm text-[var(--text-3)]">No active phone numbers</p>
              <p className="text-xs text-[var(--text-3)] text-center px-4">Add numbers using the &quot;Add&quot; button above</p>
            </div>
          ) : filtered.length === 0 && tab === "archived" ? (
            <div className="flex flex-col items-center justify-center py-24 gap-2">
              <div className="w-12 h-12 rounded-full bg-[var(--bg-card)] flex items-center justify-center mb-1">
                <Archive size={20} className="text-[var(--text-3)]" />
              </div>
              <p className="text-sm text-[var(--text-3)]">No archived numbers</p>
            </div>
          ) : (
            <div className="rounded-xl border border-[var(--border)] overflow-hidden bg-[var(--bg-app)]">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[300px]">
                  <thead>
                    <tr className="border-b border-[var(--border)] bg-[var(--bg-card)]">
                      <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Phone Number</th>
                      <th className="text-left px-4 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide hidden sm:table-cell">Added</th>
                      <th className="w-20 text-right px-3 py-3 text-xs font-semibold text-[var(--text-2)] uppercase tracking-wide">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((entry, i) => (
                      <tr key={entry.id}
                        className={`border-b border-[var(--border)] hover:bg-[var(--bg-hover)] transition-colors ${i === filtered.length - 1 ? "border-b-0" : ""}`}>
                        <td className="px-4 py-3.5">
                          <p className={`font-medium ${tab === "archived" ? "text-[var(--text-3)] line-through" : "text-[var(--text-1)]"}`}>{entry.phoneNumber}</p>
                          <p className="text-[var(--text-3)] text-xs mt-0.5 sm:hidden">{entry.addedAt}</p>
                        </td>
                        <td className="px-4 py-3.5 text-[var(--text-3)] text-xs hidden sm:table-cell">{entry.addedAt}</td>
                        <td className="px-3 py-3.5">
                          {processingId === entry.id ? (
                            <div className="flex justify-end"><Loader2 size={13} className="text-[var(--text-3)] animate-spin" /></div>
                          ) : tab === "active" ? (
                            <div className="flex justify-end">
                              <button onClick={() => handleArchive(entry.id)} title="Archive"
                                className="p-1.5 text-[var(--text-3)] hover:text-amber-400 hover:bg-amber-500/10 rounded-md transition-colors">
                                <Archive size={13} />
                              </button>
                            </div>
                          ) : (
                            <div className="flex justify-end gap-1">
                              <button onClick={() => handleRestore(entry.id)} title="Restore"
                                className="p-1.5 text-[var(--text-3)] hover:text-blue-400 hover:bg-blue-500/10 rounded-md transition-colors">
                                <RotateCcw size={13} />
                              </button>
                              <button onClick={() => handleDelete(entry.id)} title="Delete permanently"
                                className="p-1.5 text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10 rounded-md transition-colors">
                                <Trash2 size={13} />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 border-t border-[var(--border)] bg-[var(--bg-card)]">
                <p className="text-xs text-[var(--text-3)]">
                  {filtered.length === (tab === "active" ? activeEntries : archivedEntries).length
                    ? `${filtered.length} number${filtered.length !== 1 ? "s" : ""}`
                    : `${filtered.length} of ${(tab === "active" ? activeEntries : archivedEntries).length} numbers`}
                </p>
              </div>
            </div>
          )}
        </>
      )}

      {showModal && <AddPhoneNumbersModal onClose={() => setShowModal(false)} onAdd={handleAdd} />}
    </div>
  );
}

function AddPhoneNumbersModal({ onClose, onAdd }: { onClose: () => void; onAdd: (numbers: string[]) => void }) {
  const [tab, setTab] = useState<"import" | "manual">("import");
  const [dragOver, setDragOver] = useState(false);
  const [manualText, setManualText] = useState("");
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  function parseCSV(text: string): string[] {
    return text.split(/[\n,]/).map((s) => s.replace(/[^0-9+\-\s()]/g, "").trim()).filter((s) => s.replace(/\D/g, "").length >= 3);
  }

  async function handleFile(file: File) {
    const reader = new FileReader();
    reader.onload = async (e) => {
      const numbers = parseCSV(e.target?.result as string);
      if (numbers.length > 0) { setSaving(true); await onAdd(numbers); setSaving(false); }
    };
    reader.readAsText(file);
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  async function handleManualAdd() {
    const numbers = manualText.split(/[\n,;]/).map((s) => s.trim()).filter((s) => s.replace(/\D/g, "").length >= 3);
    if (numbers.length > 0) { setSaving(true); await onAdd(numbers); setSaving(false); }
  }

  function downloadSample() {
    const blob = new Blob(["phoneNumber\n+1234567890\n+0987654321"], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "dnc_sample.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/60 backdrop-blur-sm px-0 sm:px-4">
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-t-2xl sm:rounded-2xl shadow-2xl w-full sm:max-w-2xl overflow-hidden flex flex-col sm:flex-row max-h-[90vh] sm:max-h-none">
        <div className="hidden sm:flex w-52 bg-[var(--bg-app)] border-r border-[var(--border)] p-6 flex-col gap-4 flex-shrink-0">
          <div className="flex flex-col items-center gap-2 mt-4">
            <div className="w-12 h-12 rounded-full bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
              <Phone size={22} className="text-blue-400" />
            </div>
            <p className="text-sm font-semibold text-[var(--text-1)] text-center">Phone Numbers Imports</p>
            <p className="text-xs text-[var(--text-3)] text-center">Manage imports and add new.</p>
          </div>
        </div>
        <div className="flex-1 flex flex-col min-h-0">
          <div className="flex sm:hidden items-center gap-3 px-4 pt-4 pb-3 border-b border-[var(--border)]">
            <div className="w-8 h-8 rounded-full bg-blue-500/10 flex items-center justify-center">
              <Phone size={16} className="text-blue-400" />
            </div>
            <p className="flex-1 text-sm font-semibold text-[var(--text-1)]">Phone Numbers Imports</p>
            <button onClick={onClose} className="p-1.5 text-[var(--text-2)] hover:text-[var(--text-1)] rounded-lg hover:bg-[var(--bg-elevated)] transition-colors"><X size={18} /></button>
          </div>
          <div className="flex border-b border-[var(--border)] px-4 sm:px-6 pt-3 sm:pt-4 gap-4 sm:gap-6">
            {(["import", "manual"] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`pb-3 text-sm font-medium border-b-2 transition-colors ${tab === t ? "border-blue-500 text-blue-400" : "border-transparent text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
                {t === "import" ? "Import File" : "Add Manually"}
              </button>
            ))}
            <button onClick={onClose} className="hidden sm:block ml-auto mb-3 p-1 text-[var(--text-3)] hover:text-[var(--text-2)] transition-colors"><X size={18} /></button>
          </div>
          <div className="flex-1 flex flex-col items-center justify-center px-4 sm:px-6 py-6 sm:py-8 overflow-y-auto">
            {tab === "import" ? (
              <>
                <div onDragOver={(e) => { e.preventDefault(); setDragOver(true); }} onDragLeave={() => setDragOver(false)}
                  onDrop={handleDrop} onClick={() => fileRef.current?.click()}
                  className={`w-full max-w-[220px] sm:max-w-xs aspect-square rounded-full flex flex-col items-center justify-center gap-3 border-2 border-dashed transition-colors cursor-pointer ${dragOver ? "border-blue-500 bg-blue-500/5" : "border-[var(--border)] bg-[var(--bg-app)] hover:border-blue-500/50"}`}>
                  {saving ? <Loader2 size={28} className="text-blue-500 animate-spin" /> : (
                    <>
                      <div className="w-10 h-10 sm:w-12 sm:h-12 rounded-full bg-blue-500/10 flex items-center justify-center">
                        <Phone size={20} className="text-blue-400" />
                      </div>
                      <p className="text-xs sm:text-sm font-semibold text-[var(--text-2)] text-center px-4">Import DNC numbers from a file</p>
                      <p className="text-xs text-[var(--text-3)]">Drop CSV file here or</p>
                      <button className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 border border-[var(--border)] rounded-full text-xs text-[var(--text-2)] hover:bg-[var(--bg-elevated)] hover:text-[var(--text-1)] transition-colors"
                        onClick={(e) => { e.stopPropagation(); fileRef.current?.click(); }}>
                        <Upload size={11} /> Select file
                      </button>
                    </>
                  )}
                </div>
                <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
                <p className="text-xs text-[var(--text-3)] mt-5 text-center px-2">
                  Must include: <strong className="text-[var(--text-2)]">phoneNumber</strong>.{" "}
                  <button onClick={downloadSample} className="text-blue-400 hover:text-blue-300 font-medium hover:underline">Download Sample CSV</button>
                </p>
              </>
            ) : (
              <div className="w-full max-w-sm flex flex-col gap-3">
                <p className="text-sm text-[var(--text-2)]">Enter phone numbers separated by commas or new lines.</p>
                <textarea value={manualText} onChange={(e) => setManualText(e.target.value)}
                  placeholder={"+1234567890\n+0987654321"} rows={6}
                  className="w-full bg-[var(--bg-app)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 resize-none transition-all" />
                <button onClick={handleManualAdd} disabled={!manualText.trim() || saving}
                  className="flex items-center justify-center gap-2 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-30 text-white text-sm font-medium rounded-xl transition-colors shadow-md shadow-blue-600/20">
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {saving ? "Saving…" : "Add Numbers"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
