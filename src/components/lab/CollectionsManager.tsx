"use client";

import { useEffect, useState } from "react";
import {
  listCollections,
  createCollection,
  updateCollection,
  deleteCollection,
  duplicateCollection,
  getCollectionHandlerIds,
  setCollectionHandlers,
  listHandlers,
  updateHandler,
  duplicateHandler,
} from "@/lib/scriptEngine/lab-db-client";
import type { ListenerCollection, ListenerHandler } from "@/lib/scriptEngine/database.types";

const inputCls =
  "w-full rounded-md border border-[var(--border)] bg-[var(--bg-elevated)] px-2.5 py-1.5 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:border-primary focus:outline-none";


/** Inline scenario edit (item C) — the core content editable without leaving
 *  the collection. Full editing (tags/action/priority) stays on the Playbook. */
type EditDraft = {
  name: string;
  description: string;
  response_template: string;
  delivery: ListenerHandler["delivery"];
};

export default function CollectionsManager() {
  const [collections, setCollections] = useState<ListenerCollection[]>([]);
  const [handlers, setHandlers] = useState<ListenerHandler[]>([]);
  // In-use lock (VOZ-256): collections a running campaign uses are locked; the
  // operator unlocks a row before editing (edits affect the live campaign).
  const [usedIds, setUsedIds] = useState<Set<string>>(new Set());
  const [unlockedIds, setUnlockedIds] = useState<Set<string>>(new Set());
  const toggleUnlock = (id: string) =>
    setUnlockedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [members, setMembers] = useState<Set<string>>(new Set());
  // Membership captured when the collection was OPENED — drives the
  // selected-first ordering (item D) so rows don't reshuffle as you toggle.
  const [openMemberIds, setOpenMemberIds] = useState<Set<string>>(new Set());
  const [search, setSearch] = useState("");
  const [listQuery, setListQuery] = useState(""); // filters the collection list (parity with Scenarios)
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Inline scenario editing (item C)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<EditDraft | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  async function loadAll() {
    try {
      const [cols, hs, inUse] = await Promise.all([
        listCollections(),
        listHandlers(),
        fetch("/api/lab/in-use").then((r) => r.json()).catch(() => ({ collectionIds: [] })),
      ]);
      setCollections(cols);
      // first_message is prompt material; connector matchers (ignore +
      // listener) are their script's routing plumbing — neither is
      // collectible content.
      setHandlers(hs.filter((h) => h.intent_key !== "first_message" && !(h.action_type === "ignore" && h.mode === "listener")));
      setUsedIds(new Set((inUse.collectionIds as string[]) ?? []));
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
    setEditingId(null);
    setSearch("");
    try {
      const ids = await getCollectionHandlerIds(id);
      const set = new Set(ids);
      setMembers(set);
      setOpenMemberIds(new Set(set)); // snapshot for the selected-first ordering
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

  // Deep copy (item B): a new collection whose scenarios are independent
  // copies, so it can be re-branded without touching the original.
  async function handleDuplicateCollection(id: string) {
    setBusy(true);
    setNotice(null);
    try {
      const copy = await duplicateCollection(id);
      await loadAll();
      await selectCollection(copy.id);
      setNotice("Collection duplicated with independent scenario copies — edit them below for the new brand.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to duplicate collection");
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename");
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this collection? Scenarios are not deleted, only the bundle.")) return;
    try {
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
      setOpenMemberIds(new Set(members)); // re-snapshot so the ordering reflects the save
      setNotice("Scenarios saved.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save scenarios");
    } finally {
      setBusy(false);
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

  function startEdit(h: ListenerHandler) {
    setEditingId(h.id);
    setEditDraft({
      name: h.name,
      description: h.description,
      response_template: h.response_template,
      delivery: h.delivery,
    });
  }

  async function saveEdit() {
    if (!editingId || !editDraft || !editDraft.name.trim()) return;
    setSavingEdit(true);
    try {
      await updateHandler(editingId, {
        name: editDraft.name.trim(),
        description: editDraft.description,
        response_template: editDraft.response_template,
        delivery: editDraft.delivery,
      });
      await loadAll();
      setEditingId(null);
      setEditDraft(null);
      setNotice("Scenario updated.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to update scenario");
    } finally {
      setSavingEdit(false);
    }
  }

  // Duplicate a scenario from within the editor: the copy is auto-selected into
  // this collection (pending Save) and shown in the selected group.
  async function handleDuplicateScenario(id: string) {
    try {
      const dup = await duplicateHandler(id);
      await loadAll();
      setMembers((prev) => new Set(prev).add(dup.id));
      setOpenMemberIds((prev) => new Set(prev).add(dup.id));
      startEdit(dup);
      setNotice("Scenario duplicated — edit it below, then Save scenarios to keep it in this collection.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to duplicate scenario");
    }
  }

  const q = search.trim().toLowerCase();
  const filteredHandlers = q
    ? handlers.filter((h) =>
        `${h.name} ${h.intent_key} ${h.description} ${h.response_template} ${(h.tags ?? []).join(" ")}`.toLowerCase().includes(q)
      )
    : handlers;

  // Item D: selected (in this collection at open time) first, each group A→Z.
  const inCollection = filteredHandlers
    .filter((h) => openMemberIds.has(h.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const available = filteredHandlers
    .filter((h) => !openMemberIds.has(h.id))
    .sort((a, b) => a.name.localeCompare(b.name));

  const selected = collections.find((c) => c.id === selectedId) ?? null;

  // Filter the collection list by name — same searchability as Scenarios.
  const lq = listQuery.trim().toLowerCase();
  const visibleCollections = lq ? collections.filter((c) => c.name.toLowerCase().includes(lq)) : collections;
  // The open collection is locked when a running campaign uses it and it hasn't
  // been unlocked — its member editor is view-only until then.
  const selectedLocked = !!selectedId && usedIds.has(selectedId) && !unlockedIds.has(selectedId);

  function renderRow(h: ListenerHandler) {
    const checked = members.has(h.id);
    const isEditing = editingId === h.id;
    return (
      <div key={h.id} className="rounded border border-transparent hover:border-[var(--border)]/60">
        <div className="flex items-center gap-2 rounded px-2 py-1 hover:bg-[var(--bg-hover)]">
          <input type="checkbox" checked={checked} disabled={selectedLocked} onChange={() => toggleMember(h.id)} className="cursor-pointer disabled:cursor-not-allowed" />
          <span className="text-xs">{checked ? "✅" : "⬜"}</span>
          <span className="min-w-0 flex-1 truncate text-sm text-[var(--text-1)]">{h.name}</span>
          {(h.tags ?? []).slice(0, 1).map((t) => (
            <span key={t} className="shrink-0 rounded-full bg-purple-500/15 px-1.5 py-0.5 text-[9px] text-purple-300">
              {t}
            </span>
          ))}
          <button
            disabled={selectedLocked}
            onClick={() => (isEditing ? setEditingId(null) : startEdit(h))}
            className="shrink-0 rounded p-1 text-[var(--text-3)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] disabled:opacity-30 disabled:cursor-not-allowed"
            title={selectedLocked ? "In use — unlock to edit" : "Edit scenario inline"}
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
          <button
            onClick={() => handleDuplicateScenario(h.id)}
            className="shrink-0 rounded p-1 text-[var(--text-3)] transition hover:bg-[var(--bg-hover)] hover:text-primary"
            title="Duplicate scenario"
          >
            <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
            </svg>
          </button>
        </div>
        {isEditing && editDraft && (
          <div className="space-y-1.5 border-t border-[var(--border)]/60 bg-[var(--bg-elevated)] px-2 py-2">
            <input
              className={inputCls}
              value={editDraft.name}
              onChange={(e) => setEditDraft({ ...editDraft, name: e.target.value })}
              placeholder="Scenario name"
            />
            <textarea
              className={inputCls + " resize-y"}
              rows={2}
              value={editDraft.description}
              onChange={(e) => setEditDraft({ ...editDraft, description: e.target.value })}
              placeholder="When to use this (the trigger the agent listens for)…"
            />
            <textarea
              className={inputCls + " resize-y"}
              rows={2}
              value={editDraft.response_template}
              onChange={(e) => setEditDraft({ ...editDraft, response_template: e.target.value })}
              placeholder="What the agent says / does…"
            />
            <div className="flex items-center gap-2">
              <select
                className={inputCls + " [color-scheme:dark]"}
                value={editDraft.delivery}
                onChange={(e) => setEditDraft({ ...editDraft, delivery: e.target.value as ListenerHandler["delivery"] })}
              >
                <option value="reword">reword (own words)</option>
                <option value="verbatim">verbatim (word-for-word)</option>
              </select>
              <button
                onClick={saveEdit}
                disabled={savingEdit || !editDraft.name.trim()}
                className="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
              >
                {savingEdit ? "Saving…" : "Save scenario"}
              </button>
              <button
                onClick={() => { setEditingId(null); setEditDraft(null); }}
                className="shrink-0 rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-[var(--text-2)] transition hover:bg-[var(--bg-hover)]"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && <p className="text-xs text-red-400">{error}</p>}

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
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-white transition hover:-translate-y-px disabled:opacity-40"
        >
          + Create
        </button>
      </div>

      {/* Search + Collection list */}
      <div className="space-y-1.5">
        {collections.length > 0 && (
          <div className="relative">
            <svg className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-3)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              value={listQuery}
              onChange={(e) => setListQuery(e.target.value)}
              placeholder="Search collections…"
              className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] py-1.5 pl-8 pr-3 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:border-primary focus:outline-none"
            />
          </div>
        )}
        {collections.length === 0 && (
          <p className="py-4 text-center text-sm text-[var(--text-3)]">No collections yet — create one above.</p>
        )}
        {collections.length > 0 && visibleCollections.length === 0 && (
          <p className="py-4 text-center text-sm text-[var(--text-3)]">No collections match “{listQuery}”.</p>
        )}
        {visibleCollections.map((c) => {
          const inUse = usedIds.has(c.id);
          const locked = inUse && !unlockedIds.has(c.id);
          const isSelected = c.id === selectedId;
          return (
            <div
              key={c.id}
              className={`rounded-lg border px-3 py-2 ${
                isSelected ? "border-primary bg-primary/5" : "border-[var(--border)] bg-[var(--bg-elevated)]"
              }`}
            >
              <div className="flex items-center gap-2">
                <input
                  defaultValue={c.name}
                  key={c.name}
                  disabled={locked}
                  onBlur={(e) => e.target.value.trim() !== c.name && handleRename(c.id, e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                  className="flex-1 rounded-md border border-transparent bg-transparent px-1.5 py-1 text-sm font-medium text-[var(--text-1)] hover:border-[var(--border)] focus:border-primary focus:bg-[var(--bg-elevated)] focus:outline-none disabled:opacity-70"
                />
                {inUse ? (
                  <button
                    onClick={() => toggleUnlock(c.id)}
                    title={locked
                      ? "In use by a running campaign — click to unlock before editing (edits affect the live campaign)"
                      : "Unlocked — click to re-lock"}
                    className={`shrink-0 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition ${
                      locked
                        ? "border-amber-500/40 bg-amber-500/15 text-amber-300 hover:bg-amber-500/25"
                        : "border-emerald-500/40 bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25"
                    }`}
                  >
                    <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                      {locked
                        ? <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                        : <path d="M10 2a5 5 0 00-5 5v1H5a2 2 0 00-2 2v6a2 2 0 002 2h10a2 2 0 002-2v-6a2 2 0 00-2-2H7V7a3 3 0 116 0 1 1 0 102 0 5 5 0 00-5-5z" />}
                    </svg>
                    In use
                  </button>
                ) : (
                  <span className="shrink-0 text-[10px] font-medium text-[var(--text-3)]">Not in use</span>
                )}
                <button
                  onClick={() => (isSelected ? setSelectedId(null) : selectCollection(c.id))}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-2)] transition hover:bg-[var(--bg-hover)]"
                >
                  {isSelected ? "Close" : "Edit scenarios"}
                </button>
                <button
                  onClick={() => handleDuplicateCollection(c.id)}
                  disabled={busy}
                  className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[11px] text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] hover:text-primary disabled:opacity-40"
                  title="Duplicate this collection and all its scenarios (independent copies)"
                >
                  Duplicate
                </button>
                <button
                  onClick={() => handleDelete(c.id)}
                  disabled={locked}
                  className="shrink-0 rounded p-1 text-[var(--text-3)] transition hover:bg-[var(--bg-hover)] hover:text-rose-400 disabled:opacity-30 disabled:cursor-not-allowed"
                  title={locked ? "In use — unlock to delete" : "Delete collection"}
                >
                  <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              </div>

              {/* Member editor */}
              {isSelected && (
                <div className="mt-2 border-t border-[var(--border)]/60 pt-2">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <input
                      className={inputCls}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter scenarios…"
                    />
                    <span className="shrink-0 text-[11px] text-[var(--text-3)]">{members.size} selected</span>
                  </div>
                  <div className="max-h-80 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] p-1.5">
                    <p className="px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400/80">
                      In this collection ({inCollection.length})
                    </p>
                    {inCollection.length === 0 && (
                      <p className="px-2 py-1 text-xs text-[var(--text-3)]">None yet — tick scenarios below to add them.</p>
                    )}
                    {inCollection.map(renderRow)}
                    <p className="mt-2 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                      Available scenarios ({available.length})
                    </p>
                    {available.map(renderRow)}
                  </div>
                  {notice && <p className="mt-1.5 text-xs text-emerald-400">{notice}</p>}
                  {selectedLocked && (
                    <p className="mt-1.5 text-xs text-amber-300">In use by a running campaign — click “In use” above to unlock before changing members.</p>
                  )}
                  <button
                    onClick={handleSaveMembers}
                    disabled={busy || selectedLocked}
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
