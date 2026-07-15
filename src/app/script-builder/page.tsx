"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import ScriptBuilder from "@/components/lab/ScriptBuilder";
import { listScripts, createScript, deleteScript, getLabSettings } from "@/lib/scriptEngine/lab-db-client";
import type { ListenerScript } from "@/lib/scriptEngine/database.types";

const PAGE_SIZE = 10;

export default function ScriptBuilderPage() {
  return (
    <Suspense fallback={<div className="px-4 py-10 text-sm text-gray-500 sm:px-6">Loading…</div>}>
      <ScriptBuilderInner />
    </Suspense>
  );
}

function ScriptBuilderInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Selected script lives in the URL (?id=…) so a refresh reopens the same one.
  const editingId = searchParams.get("id");
  const openScript = (id: string) => router.push(`/script-builder?id=${id}`);
  const backToList = () => router.push("/script-builder");

  const [scripts, setScripts] = useState<ListenerScript[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const [scs, settings] = await Promise.all([listScripts(), getLabSettings().catch(() => null)]);
      setScripts(scs);
      setActiveId(settings?.active_script_id ?? null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scripts — did you run the scripts migration?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!editingId) reload();
  }, [editingId]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const base = q ? scripts.filter((s) => `${s.name} ${s.description}`.toLowerCase().includes(q)) : scripts;
    // Most recently updated first — new scripts must not hide on page 2.
    return [...base].sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }, [scripts, search]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const paginated = filtered.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  async function handleCreate() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const s = await createScript(newName.trim());
      setNewName("");
      openScript(s.id); // jump straight into the builder
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(e: React.MouseEvent, id: string) {
    e.stopPropagation();
    if (!window.confirm("Delete this script and its flow?")) return;
    try {
      await deleteScript(id);
      reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to delete");
    }
  }

  // ── Editor view ──
  if (editingId) {
    return <ScriptBuilder initialScriptId={editingId} onClose={backToList} />;
  }

  // ── List view ──
  return (
    <div className="flex flex-col px-4 py-6 pb-[env(safe-area-inset-bottom)] sm:px-6 sm:py-8">
      <header className="mb-5 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Script Builder</h1>
          <p className="mt-1 text-sm text-gray-500">
            {filtered.length} of {scripts.length} script{scripts.length !== 1 ? "s" : ""} — open one to edit its
            call flow, or create a new one.
          </p>
        </div>
      </header>

      {/* Create + search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search scripts..."
            className="w-full rounded-lg border border-gray-700 bg-gray-800/50 py-2.5 pl-10 pr-4 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        <div className="flex gap-2">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            placeholder="New script name…"
            className="w-48 rounded-lg border border-gray-700 bg-gray-800/50 px-3 py-2.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
          <button
            onClick={handleCreate}
            disabled={busy || !newName.trim()}
            className="shrink-0 rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
          >
            + New Script
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-xl border border-gray-700 bg-gray-800/50 overflow-hidden">
        {!loading && !error && filtered.length > 0 && (
          <div className="hidden sm:grid grid-cols-[1fr_180px_90px] gap-4 border-b border-gray-700 px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-gray-500">
            <span>Name</span>
            <span>Last updated</span>
            <span />
          </div>
        )}

        {loading && <p className="px-5 py-10 text-center text-sm text-gray-500">Loading scripts...</p>}
        {!loading && error && <p className="px-5 py-10 text-center text-sm text-red-400">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-gray-500">
            {scripts.length === 0 ? "No scripts yet — create your first one above." : "No scripts match your search."}
          </p>
        )}

        {paginated.map((s) => (
          <div
            key={s.id}
            onClick={() => openScript(s.id)}
            className="grid cursor-pointer grid-cols-[1fr_auto] sm:grid-cols-[1fr_180px_90px] items-center gap-4 border-b border-gray-700/50 px-5 py-3.5 transition last:border-b-0 hover:bg-gray-700/30"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-gray-200">{s.name}</span>
                {s.id === activeId && (
                  <span className="shrink-0 rounded-full bg-emerald-500/20 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    Active
                  </span>
                )}
              </div>
              {s.description && <p className="truncate text-xs text-gray-500">{s.description}</p>}
              <p className="mt-0.5 text-[11px] text-gray-600 sm:hidden">
                {new Date(s.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
            <span className="hidden sm:block text-sm text-gray-400">
              {new Date(s.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {", "}
              {new Date(s.updated_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
            <div className="flex justify-end gap-1">
              <button
                onClick={(e) => { e.stopPropagation(); openScript(s.id); }}
                className="rounded-lg border border-gray-600 px-2.5 py-1 text-xs text-gray-300 transition hover:bg-gray-700"
              >
                Open
              </button>
              <button
                onClick={(e) => handleDelete(e, s.id)}
                className="rounded p-1.5 text-gray-500 transition hover:bg-gray-700 hover:text-rose-400"
                title="Delete"
              >
                <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-gray-500">Page {pageClamped} of {totalPages} · {filtered.length} scripts</p>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageClamped === 1}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:text-gray-200 disabled:opacity-40">
              Previous
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageClamped === totalPages}
              className="rounded-lg border border-gray-700 px-3 py-1.5 text-sm text-gray-400 transition hover:text-gray-200 disabled:opacity-40">
              Next
            </button>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-gray-600">
        Tip: open a script to edit its flow on the canvas. Set one “active” inside the builder to drive test calls.
      </p>
    </div>
  );
}
