"use client";

import { useEffect, useState } from "react";
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  getCollectionHandlerIds,
  setCollectionHandlers,
  listHandlers,
  getLabSettings,
  saveLabSettings,
} from "@/lib/scriptEngine/lab-db-client";
import type { ListenerCollection, ListenerHandler } from "@/lib/scriptEngine/database.types";

const inputCls =
  "w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none";

type Props = {
  /** Notifies the page when the active collection changes (id, name|null) */
  onActiveChange?: (id: string | null, name: string | null) => void;
};

export default function CollectionsManager({ onActiveChange }: Props) {
  const [collections, setCollections] = useState<ListenerCollection[]>([]);
  const [handlers, setHandlers] = useState<ListenerHandler[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadAll() {
    try {
      const [cols, hs, settings] = await Promise.all([
        listCollections(),
        listHandlers(),
        getLabSettings(),
      ]);
      setCollections(cols);
      // first_message is prompt material; connector matchers (ignore +
      // listener) are their script's routing plumbing — neither is
      // collectible content.
      setHandlers(hs.filter((h) => h.intent_key !== "first_message" && !(h.action_type === "ignore" && h.mode === "listener")));
      setActiveId(settings?.active_collection_id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load — did you run the migration?");
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function selectCollection(id: string) {
    setSelectedId(id);
    setNotice(null);
    try {
      const ids = await getCollectionHandlerIds(id);
      setMembers(new Set(ids));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scenarios");
    }
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const c = await createCollection(newName.trim());
      setNewName("");
      await loadAll();
      selectCollection(c.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create collection");
    } finally {
      setBusy(false);
    }
  }

  async function handleRename(id: string, name: string) {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      await updateCollection(id, { name: trimmed });
      await loadAll();
      if (activeId === id) onActiveChange?.(id, trimmed);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this collection? Scenarios are not deleted, only the bundle.")) return;
    try {
      if (activeId === id) {
        await saveLabSettings({ active_collection_id: null });
        setActiveId(null);
        onActiveChange?.(null, null);
      }
      await deleteCollection(id);
      if (selectedId === id) setSelectedId(null);
      await loadAll();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete");
    }
  }

  async function handleSaveMembers() {
    if (!selectedId) return;
    setBusy(true);
    setNotice(null);
    try {
      await setCollectionHandlers(selectedId, Array.from(members));
      await loadAll();
      setNotice("Scenarios saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save scenarios");
    } finally {
      setBusy(false);
    }
  }

  async function handleSetActive(id: string | null) {
    try {
      await saveLabSettings({ active_collection_id: id });
      setActiveId(id);
      const name = id ? collections.find((c) => c.id === id)?.name ?? null : null;
      onActiveChange?.(id, name);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set active");
    }
  }

  function toggleMember(id: string) {
    setMembers((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const q = search.trim().toLowerCase();
  const filteredHandlers = q
    ? handlers.filter((h) =>
        `${h.name} ${h.intent_key} ${(h.tags ?? []).join(" ")}`.toLowerCase().includes(q)
      )
    : handlers;

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-400">{error}</p>}

      {/* Active collection banner */}
      <div className="rounded-lg border border-gray-700 bg-gray-900/50 px-3 py-2.5">
        <p className="text-[11px] uppercase tracking-wider text-gray-500">Active for test calls</p>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-sm font-medium text-gray-200">
            {activeId ? collections.find((c) => c.id === activeId)?.name ?? "—" : "All scenarios (no collection)"}
          </p>
          {activeId && (
            <button
              onClick={() => handleSetActive(null)}
              className="rounded-lg border border-gray-700 px-2.5 py-1 text-[11px] text-gray-300 transition hover:bg-gray-800"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {/* Create */}
      <div className="flex gap-2">
        <input
          className={inputCls}
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder="New collection name (e.g. Lucky7 AU Reactivation)"
        />
        <button
          onClick={handleCreate}
          disabled={busy || !newName.trim()}
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
        >
          + Create
        </button>
      </div>

      {/* Collection list */}
      <div className="space-y-1.5">
        {collections.length === 0 && (
          <p className="py-4 text-center text-sm text-gray-500">No collections yet — create one above.</p>
        )}
        {collections.map((c) => {
          const isActive = c.id === activeId;
          const isSelected = c.id === selectedId;
          return (
            <div
              key={c.id}
              className={`rounded-lg border px-3 py-2 ${
                isSelected ? "border-indigo-500 bg-indigo-500/5" : "border-gray-700 bg-gray-900/40"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  defaultValue={c.name}
                  onBlur={(e) => e.target.value.trim() !== c.name && handleRename(c.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-gray-200 hover:border-gray-700 focus:border-indigo-500 focus:bg-gray-800 focus:outline-none"
                />
                {isActive && (
                  <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    Active
                  </span>
                )}
                <button
                  onClick={() => handleSetActive(c.id)}
                  disabled={isActive}
                  className="shrink-0 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-300 transition hover:bg-gray-800 disabled:opacity-40"
                >
                  Set active
                </button>
                <button
                  onClick={() => (isSelected ? setSelectedId(null) : selectCollection(c.id))}
                  className="shrink-0 rounded-lg border border-gray-700 px-2 py-1 text-[11px] text-gray-300 transition hover:bg-gray-800"
                >
                  {isSelected ? "Close" : "Edit scenarios"}
                </button>
                <button
                  onClick={() => handleDelete(c.id)}
                  className="shrink-0 rounded p-1 text-gray-500 transition hover:bg-gray-700 hover:text-rose-400"
                  title="Delete collection"
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              {/* Member editor */}
              {isSelected && (
                <div className="mt-2 border-t border-gray-700/60 pt-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <input
                      className={inputCls}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter scenarios…"
                    />
                    <span className="shrink-0 text-[11px] text-gray-500">{members.size} scenarios selected</span>
                  </div>
                  <div className="max-h-64 space-y-1 overflow-y-auto rounded-lg border border-gray-700 p-1.5">
                    {filteredHandlers.map((h) => (
                      <label
                        key={h.id}
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-gray-800"
                      >
                        <input
                          type="checkbox"
                          checked={members.has(h.id)}
                          onChange={() => toggleMember(h.id)}
                        />
                        <span className="text-sm text-gray-200">{h.name}</span>
                        {(h.tags ?? []).slice(0, 1).map((t) => (
                          <span key={t} className="rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] text-purple-300">
                            {t}
                          </span>
                        ))}
                      </label>
                    ))}
                  </div>
                  {notice && <p className="mt-1.5 text-xs text-emerald-400">{notice}</p>}
                  <button
                    onClick={handleSaveMembers}
                    disabled={busy}
                    className="mt-2 w-full rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-emerald-500 disabled:opacity-40"
                  >
                    {busy ? "Saving…" : `Save scenarios for ${selected?.name ?? "collection"}`}
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
