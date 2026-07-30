"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { BookOpen } from "lucide-react";
import ScriptBuilder from "@/components/lab/ScriptBuilder";
import { SectionTick } from "@/app/analytics/SectionIsland";
import { listScripts, createScript } from "@/lib/scriptEngine/lab-db-client";
import { fetchCampaignsV2 } from "@/lib/campaignV2Client";
import type { ListenerScript } from "@/lib/scriptEngine/database.types";

const PAGE_SIZE = 10;

export default function ScriptBuilderPage() {
  return (
    <Suspense fallback={<div className="px-4 py-10 text-sm text-[var(--text-3)] sm:px-6">Loading…</div>}>
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
  // Scripts a running/paused campaign is using → shown locked (production), not test.
  const [usedScriptIds, setUsedScriptIds] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false); // "New script" modal

  async function reload() {
    setLoading(true);
    try {
      const [scs, camps] = await Promise.all([listScripts(), fetchCampaignsV2().catch(() => [])]);
      setScripts(scs);
      // A running/paused campaign references its template by script_id — lock those.
      const used = new Set<string>();
      for (const c of camps as { status?: string; script_id?: string | null }[]) {
        if ((c.status === "running" || c.status === "paused") && c.script_id) used.add(c.script_id);
      }
      setUsedScriptIds(used);
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

  function openCreate() {
    setNewName("");
    setError(null);
    setShowCreate(true);
  }

  async function handleCreate() {
    if (!newName.trim()) return;
    setBusy(true);
    try {
      const s = await createScript(newName.trim());
      setNewName("");
      setShowCreate(false);
      openScript(s.id); // jump straight into the builder
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create");
    } finally {
      setBusy(false);
    }
  }

  // ── Editor view ──
  if (editingId) {
    return <ScriptBuilder initialScriptId={editingId} onClose={backToList} />;
  }

  // ── List view ──
  return (
    <div className="p-4 w-full max-w-[1400px] mx-auto flex flex-col">
      <header className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <SectionTick color="#4d90f0" />
            <h1 className="text-lg font-semibold tracking-tight text-[var(--text-1)]">Script Builder</h1>
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-3)]">
            {filtered.length} of {scripts.length} script{scripts.length !== 1 ? "s" : ""} — open one to edit its
            call flow, or create a new one.
          </p>
        </div>
        <Link
          href="/playbook"
          className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-[var(--border-2)] px-3 py-2 text-sm font-medium text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]"
        >
          <BookOpen className="h-4 w-4" />
          Playbook
        </Link>
      </header>

      {/* Create + search */}
      <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--text-3)]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search scripts..."
            className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-card)] py-2.5 pl-10 pr-4 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:border-primary focus:outline-none"
          />
        </div>
        <button
          onClick={openCreate}
          className="shrink-0 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-white transition hover:-translate-y-px"
        >
          + New Script
        </button>
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        {!loading && !error && filtered.length > 0 && (
          <div className="hidden sm:grid grid-cols-[1fr_180px_90px] gap-4 border-b border-[var(--border)] px-5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
            <span>Name</span>
            <span>Last updated</span>
            <span />
          </div>
        )}

        {loading && <p className="px-5 py-10 text-center text-sm text-[var(--text-3)]">Loading scripts...</p>}
        {!loading && error && <p className="px-5 py-10 text-center text-sm text-red-400">{error}</p>}
        {!loading && !error && filtered.length === 0 && (
          <p className="px-5 py-10 text-center text-sm text-[var(--text-3)]">
            {scripts.length === 0 ? "No scripts yet — create your first one above." : "No scripts match your search."}
          </p>
        )}

        {paginated.map((s) => (
          <div
            key={s.id}
            onClick={() => openScript(s.id)}
            className="grid cursor-pointer grid-cols-[1fr_auto] sm:grid-cols-[1fr_180px_90px] items-center gap-4 border-b border-[var(--border)] px-5 py-3.5 transition last:border-b-0 hover:bg-[var(--bg-elevated)]"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="truncate text-sm font-medium text-[var(--text-1)]">{s.name}</span>
                {usedScriptIds.has(s.id) && (
                  <span
                    className="shrink-0 inline-flex items-center gap-1 rounded-full border border-amber-500/30 bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold text-amber-300"
                    title="In use by a running campaign — open it and unlock before editing"
                  >
                    <svg className="h-2.5 w-2.5" fill="currentColor" viewBox="0 0 20 20">
                      <path fillRule="evenodd" d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z" clipRule="evenodd" />
                    </svg>
                    In use
                  </span>
                )}
              </div>
              {s.description && <p className="truncate text-xs text-[var(--text-3)]">{s.description}</p>}
              <p className="mt-0.5 text-[11px] text-[var(--text-3)] sm:hidden">
                {new Date(s.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              </p>
            </div>
            <span className="hidden sm:block text-sm text-[var(--text-3)]">
              {new Date(s.updated_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
              {", "}
              {new Date(s.updated_at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}
            </span>
            {/* Row opens on click; delete lives inside the editor (avoids misclicks). */}
            <div className="flex justify-end text-[var(--text-3)]">
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="mt-4 flex items-center justify-between gap-2">
          <p className="text-xs text-[var(--text-3)]">Page {pageClamped} of {totalPages} · {filtered.length} scripts</p>
          <div className="flex gap-2">
            <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={pageClamped === 1}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-3)] transition hover:text-[var(--text-1)] disabled:opacity-40">
              Previous
            </button>
            <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={pageClamped === totalPages}
              className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-sm text-[var(--text-3)] transition hover:text-[var(--text-1)] disabled:opacity-40">
              Next
            </button>
          </div>
        </div>
      )}

      <p className="mt-4 text-xs text-[var(--text-3)]">
        Tip: click a script to edit its flow. A script marked <span className="text-amber-300">In use</span> is live in a
        running campaign — open it and unlock before editing. Delete lives inside the editor.
      </p>

      {/* New-script modal — name it here, then jump into the builder. */}
      {showCreate && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={() => !busy && setShowCreate(false)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div onClick={(e) => e.stopPropagation()} className="relative w-full max-w-md space-y-4 rounded-2xl border border-[var(--border)] bg-[var(--bg-card)] p-5 shadow-2xl">
            <h3 className="text-base font-bold text-[var(--text-1)]">New script</h3>
            <div>
              <label className="mb-1 block text-xs text-[var(--text-3)]">Script name</label>
              <input
                autoFocus
                type="text"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleCreate();
                  else if (e.key === "Escape" && !busy) setShowCreate(false);
                }}
                placeholder="e.g. Lucky7 AU Reactivation"
                className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5 text-sm text-[var(--text-1)] placeholder-[var(--text-3)] focus:border-primary focus:outline-none"
              />
            </div>
            {error && <p className="text-xs text-red-400">{error}</p>}
            <div className="flex gap-2">
              <button
                onClick={() => setShowCreate(false)}
                disabled={busy}
                className="flex-1 rounded-lg border border-[var(--border)] px-4 py-2 text-sm font-medium text-[var(--text-2)] transition hover:bg-[var(--bg-hover)] disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleCreate}
                disabled={busy || !newName.trim()}
                className="flex-1 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white transition hover:-translate-y-px disabled:opacity-40"
              >
                {busy ? "Creating…" : "Create script"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
