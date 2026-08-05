"use client";

// PromptLibrary — manage the QA prompt library used by the tester: list, create,
// edit, set-default, delete. Data: /api/qa-prompt-testing/prompts (+ /[id]).

import { useCallback, useEffect, useState } from "react";
import { Check, Pencil, Plus, Star, Trash2, X } from "lucide-react";

interface QaPrompt {
  id: string;
  title: string;
  content: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const fmt = (iso: string) => {
  try {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(iso));
  } catch {
    return "";
  }
};

export default function PromptLibrary() {
  const [prompts, setPrompts] = useState<QaPrompt[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<"new" | string | null>(null);
  const [form, setForm] = useState({ title: "", content: "", isActive: false });
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetch("/api/qa-prompt-testing/prompts", { cache: "no-store" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const { prompts } = (await r.json()) as { prompts: QaPrompt[] };
      setPrompts(prompts);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load prompts");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const openNew = () => {
    setForm({ title: "", content: "", isActive: prompts.length === 0 });
    setEditing("new");
  };
  const openEdit = (p: QaPrompt) => {
    setForm({ title: p.title, content: p.content, isActive: p.isActive });
    setEditing(p.id);
  };
  const cancel = () => {
    setEditing(null);
    setForm({ title: "", content: "", isActive: false });
  };

  const save = async () => {
    if (!form.title.trim() || !form.content.trim()) {
      setError("Title and content are required");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const isNew = editing === "new";
      const r = await fetch(isNew ? "/api/qa-prompt-testing/prompts" : `/api/qa-prompt-testing/prompts/${editing}`, {
        method: isNew ? "POST" : "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: form.title.trim(), content: form.content, isActive: form.isActive }),
      });
      if (!r.ok) {
        const b = (await r.json().catch(() => ({}))) as { error?: string };
        throw new Error(b.error || `HTTP ${r.status}`);
      }
      cancel();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save prompt");
    } finally {
      setSaving(false);
    }
  };

  const setDefault = async (id: string) => {
    setError(null);
    try {
      const r = await fetch(`/api/qa-prompt-testing/prompts/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ isActive: true }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set default");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("Delete this prompt from the library?")) return;
    setError(null);
    try {
      const r = await fetch(`/api/qa-prompt-testing/prompts/${id}`, { method: "DELETE" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete prompt");
    }
  };

  return (
    <div className="grid gap-3">
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-[var(--text-3)]">
          Reusable QA prompts. The <span className="text-[var(--text-2)]">default</span> is pre-loaded when you open a call.
        </p>
        {editing === null && (
          <button
            onClick={openNew}
            className="inline-flex items-center gap-1.5 bg-primary hover:opacity-90 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition shrink-0"
          >
            <Plus size={14} /> New prompt
          </button>
        )}
      </div>

      {error && <p className="text-[11px] text-red-400">{error}</p>}

      {editing !== null && (
        <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-4 grid gap-3">
          <input
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            placeholder="Prompt title"
            className="w-full text-sm bg-[var(--bg-elevated)]/40 border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50"
          />
          <textarea
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
            placeholder="Write or paste the QA system prompt…"
            rows={14}
            className="w-full text-xs font-mono leading-relaxed bg-[var(--bg-elevated)]/40 border border-[var(--border)] rounded-lg px-3 py-2.5 text-[var(--text-1)] placeholder:text-[var(--text-3)] focus:outline-none focus:border-primary/50 resize-y"
          />
          <label className="inline-flex items-center gap-2 text-xs text-[var(--text-2)] cursor-pointer">
            <input
              type="checkbox"
              checked={form.isActive}
              onChange={(e) => setForm((f) => ({ ...f, isActive: e.target.checked }))}
              className="accent-[var(--color-primary)]"
            />
            Set as default (pre-loaded in the tester)
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="inline-flex items-center gap-1.5 bg-primary hover:opacity-90 disabled:opacity-40 text-white text-xs font-medium px-3 py-1.5 rounded-lg transition"
            >
              <Check size={14} /> {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={cancel}
              className="inline-flex items-center gap-1.5 text-[var(--text-2)] hover:text-[var(--text-1)] text-xs font-medium px-3 py-1.5 rounded-lg hover:bg-[var(--bg-hover)] transition"
            >
              <X size={14} /> Cancel
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="grid gap-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 rounded-2xl bg-[var(--bg-elevated)] animate-pulse" />
          ))}
        </div>
      ) : prompts.length === 0 && editing === null ? (
        <div className="text-center py-12 text-sm text-[var(--text-3)]">
          No prompts yet. Click <span className="text-[var(--text-2)]">New prompt</span> to add your first QA prompt.
        </div>
      ) : (
        <div className="grid gap-2">
          {prompts.map((p) => (
            <div
              key={p.id}
              className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl px-4 py-3 flex items-start gap-3"
            >
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium text-[var(--text-1)] truncate">{p.title}</span>
                  {p.isActive && (
                    <span className="text-[9px] font-bold uppercase bg-emerald-500/15 text-emerald-400 px-1.5 py-0.5 rounded-full shrink-0">
                      default
                    </span>
                  )}
                </div>
                <p className="text-[11px] text-[var(--text-3)] mt-1 line-clamp-2 break-words">
                  {p.content.slice(0, 180)}
                  {p.content.length > 180 ? "…" : ""}
                </p>
                <p className="text-[10px] text-[var(--text-3)] font-mono mt-1">updated {fmt(p.updatedAt)}</p>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                {!p.isActive && (
                  <button
                    onClick={() => setDefault(p.id)}
                    title="Set as default"
                    className="p-1.5 rounded-lg text-[var(--text-3)] hover:text-amber-400 hover:bg-[var(--bg-hover)] transition"
                  >
                    <Star size={14} />
                  </button>
                )}
                <button
                  onClick={() => openEdit(p)}
                  title="Edit"
                  className="p-1.5 rounded-lg text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition"
                >
                  <Pencil size={14} />
                </button>
                <button
                  onClick={() => remove(p.id)}
                  title="Delete"
                  className="p-1.5 rounded-lg text-[var(--text-3)] hover:text-red-400 hover:bg-red-500/10 transition"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
