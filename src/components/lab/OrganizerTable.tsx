"use client";

import { useEffect, useState } from "react";
import {
  listHandlers,
  createHandler,
  updateHandler,
  deleteHandler,
  duplicateHandler,
} from "@/lib/scriptEngine/lab-db-client";
import type { ListenerHandler } from "@/lib/scriptEngine/database.types";

const inputCls =
  "w-full rounded-md border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none";

const ACTION_COLORS: Record<string, string> = {
  answer: "bg-indigo-500/15 text-indigo-300",
  give_offer: "bg-emerald-500/15 text-emerald-300",
  send_sms: "bg-amber-500/15 text-amber-300",
  end_call: "bg-rose-500/15 text-rose-300",
  ignore: "bg-gray-700 text-gray-400",
};

const STARTER_HANDLERS = [
  {
    name: "Greeting",
    intent_key: "greeting",
    description: "The customer says hello, hi, good morning, or asks who's calling.",
    response_template: "Greet them warmly and briefly say why you're calling.",
    action_type: "answer" as const,
    delivery: "reword" as const,
    tags: ["Greeting"],
    priority: 10,
  },
  {
    name: "Pricing Question",
    intent_key: "pricing_question",
    description: "Questions about price, cost, fees, how much something is.",
    response_template: "The standard plan is forty-nine dollars a month, with no setup fee.",
    action_type: "answer" as const,
    delivery: "verbatim" as const,
    tags: ["Q&A"],
    priority: 20,
  },
  {
    name: "Give Offer",
    intent_key: "give_offer",
    description: "The customer shows interest, asks what you can do for them, or asks about deals/promotions.",
    response_template: "We've got a special three hundred percent deposit bonus available today only.",
    action_type: "give_offer" as const,
    delivery: "verbatim" as const,
    tags: ["Promotions"],
    priority: 30,
  },
  {
    name: "Send SMS",
    intent_key: "send_sms",
    description: "The customer agrees to receive details by text/SMS, or asks you to text them.",
    response_template: "Perfect — I'll text you the details right now.",
    action_type: "send_sms" as const,
    delivery: "verbatim" as const,
    tags: ["SMS"],
    priority: 40,
  },
  {
    name: "Goodbye / Not Interested",
    intent_key: "goodbye",
    description: "The customer says goodbye, asks to end the call, or firmly says they're not interested after the offer was presented.",
    response_template: "Thanks so much for your time today. Have a great day. Goodbye!",
    action_type: "end_call" as const,
    delivery: "verbatim" as const,
    tags: ["Closing"],
    priority: 50,
  },
];

type Draft = {
  id?: string;
  name: string;
  intent_key: string;
  description: string;
  response_template: string;
  action_type: ListenerHandler["action_type"];
  delivery: ListenerHandler["delivery"];
  tags: string[];
  mode: ListenerHandler["mode"];
  priority: number;
  enabled: boolean;
};

const EMPTY_DRAFT: Draft = {
  name: "",
  intent_key: "",
  description: "",
  response_template: "",
  action_type: "answer",
  delivery: "verbatim",
  tags: [],
  mode: "both",
  priority: 100,
  enabled: true,
};

const PAGE_SIZE = 8;

export default function OrganizerTable() {
  const [handlers, setHandlers] = useState<ListenerHandler[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [seeding, setSeeding] = useState(false);
  const [search, setSearch] = useState("");
  const [tagFilter, setTagFilter] = useState("");
  const [page, setPage] = useState(1);
  const [newTag, setNewTag] = useState("");

  async function reload() {
    try {
      setHandlers(await listHandlers());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load scenarios");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
  }, []);

  useEffect(() => {
    setPage(1);
  }, [search, tagFilter]);

  // Connector matchers (reply detectors) are routing plumbing owned by their
  // script's arrows — edited on the arrow itself, never reusable content.
  // They don't belong in the Playbook's scenario list.
  const visible = handlers.filter((h) => !(h.action_type === "ignore" && h.mode === "listener"));

  const allTags = Array.from(
    new Set(visible.flatMap((h) => h.tags ?? []).filter(Boolean))
  ).sort();

  const q = search.trim().toLowerCase();
  const filtered = visible.filter((h) => {
    if (tagFilter && !(h.tags ?? []).includes(tagFilter)) return false;
    if (
      q &&
      !`${h.name} ${h.intent_key} ${h.description} ${h.response_template} ${h.action_type} ${h.delivery} ${(h.tags ?? []).join(" ")}`
        .toLowerCase()
        .includes(q)
    )
      return false;
    return true;
  });
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageClamped = Math.min(page, totalPages);
  const paginated = filtered.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  async function handleSeed() {
    setSeeding(true);
    try {
      for (const h of STARTER_HANDLERS) {
        await createHandler(h);
      }
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to seed scenarios");
    } finally {
      setSeeding(false);
    }
  }

  function addTag(tag: string) {
    if (!draft) return;
    const t = tag.trim();
    if (!t || draft.tags.includes(t)) return;
    setDraft({ ...draft, tags: [...draft.tags, t] });
    setNewTag("");
  }
  function removeTag(tag: string) {
    if (!draft) return;
    setDraft({ ...draft, tags: draft.tags.filter((t) => t !== tag) });
  }

  // The intent key is an internal id — auto-generate it from the name (unique).
  function makeIntentKey(name: string, currentId?: string): string {
    const base = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "scenario";
    const taken = new Set(handlers.filter((h) => h.id !== currentId).map((h) => h.intent_key));
    if (!taken.has(base)) return base;
    let i = 2;
    while (taken.has(`${base}_${i}`)) i++;
    return `${base}_${i}`;
  }

  async function handleSaveDraft() {
    if (!draft || !draft.name.trim()) return;
    setSaving(true);
    try {
      const payload = {
        name: draft.name.trim(),
        // Keep the existing key on edit; auto-generate for new scenarios.
        intent_key: draft.id ? draft.intent_key : makeIntentKey(draft.name),
        description: draft.description,
        response_template: draft.response_template,
        action_type: draft.action_type,
        delivery: draft.delivery,
        tags: draft.tags,
        mode: draft.mode,
        priority: draft.priority,
        enabled: draft.enabled,
      };
      if (draft.id) {
        await updateHandler(draft.id, payload);
      } else {
        await createHandler(payload);
      }
      setDraft(null);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save scenario");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id: string) {
    if (!window.confirm("Delete this scenario?")) return;
    try {
      await deleteHandler(id);
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete scenario");
    }
  }

  // Clone a scenario into an independent "(copy)" with a fresh intent_key, then
  // open it in the editor so it can be tweaked immediately.
  async function handleDuplicate(id: string) {
    try {
      const dup = await duplicateHandler(id);
      await reload();
      setDraft({
        id: dup.id,
        name: dup.name,
        intent_key: dup.intent_key,
        description: dup.description,
        response_template: dup.response_template,
        action_type: dup.action_type,
        delivery: dup.delivery,
        tags: dup.tags ?? [],
        mode: dup.mode,
        priority: dup.priority,
        enabled: dup.enabled,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to duplicate scenario");
    }
  }

  async function handleToggle(h: ListenerHandler) {
    try {
      await updateHandler(h.id, { enabled: !h.enabled });
      setHandlers((hs) =>
        hs.map((x) => (x.id === h.id ? { ...x, enabled: !x.enabled } : x))
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to toggle scenario");
    }
  }


  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/50 overflow-hidden">
      <div className="flex items-center gap-2 border-b border-gray-700 px-4 py-3">
        <div className="relative flex-1">
          <svg className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search scenarios…"
            className="w-full rounded-lg border border-gray-700 bg-gray-800 py-1.5 pl-8 pr-3 text-sm text-gray-200 placeholder-gray-500 focus:border-indigo-500 focus:outline-none"
          />
        </div>
        {allTags.length > 0 && (
          <select
            value={tagFilter}
            onChange={(e) => setTagFilter(e.target.value)}
            className="shrink-0 rounded-lg border border-gray-700 bg-gray-800 px-2.5 py-1.5 text-sm text-gray-200 focus:border-indigo-500 focus:outline-none [color-scheme:dark]"
          >
            <option value="">All tags</option>
            {allTags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
        <button
          onClick={() => setDraft({ ...EMPTY_DRAFT })}
          className="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-indigo-500"
        >
          + Add Scenario
        </button>
      </div>

      {error && <p className="px-4 py-2 text-xs text-red-400">{error}</p>}

      {loading && <p className="px-4 py-8 text-center text-sm text-gray-500">Loading scenarios...</p>}

      {!loading && handlers.length === 0 && !draft && (
        <div className="px-4 py-8 text-center">
          <p className="mb-3 text-sm text-gray-500">No scenarios yet.</p>
          <button
            onClick={handleSeed}
            disabled={seeding}
            className="rounded-lg border border-gray-600 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-700 disabled:opacity-40"
          >
            {seeding ? "Adding..." : "Add starter scenarios (greeting, pricing, offer, SMS, goodbye)"}
          </button>
        </div>
      )}

      {!loading && handlers.length > 0 && filtered.length === 0 && (
        <p className="px-4 py-8 text-center text-sm text-gray-500">No scenarios match your filters.</p>
      )}

      {paginated.map((h) => (
        <div
          key={h.id}
          className={`flex flex-wrap items-center gap-3 border-b border-gray-700/50 px-4 py-3 last:border-b-0 ${
            h.enabled ? "" : "opacity-50"
          }`}
        >
          <button
            onClick={() => handleToggle(h)}
            title={h.enabled ? "Disable" : "Enable"}
            className={`relative h-5 w-9 shrink-0 rounded-full transition ${
              h.enabled ? "bg-emerald-600" : "bg-gray-600"
            }`}
          >
            <span
              className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${
                h.enabled ? "left-[18px]" : "left-0.5"
              }`}
            />
          </button>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-gray-200">{h.name}</span>
              {(h.tags ?? []).map((t) => (
                <span key={t} className="rounded-full bg-purple-500/15 px-2 py-0.5 text-[10px] font-medium text-purple-300">
                  {t}
                </span>
              ))}
              <code className="rounded bg-gray-700/60 px-1.5 py-0.5 text-[10px] text-gray-400">
                {h.intent_key}
              </code>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  ACTION_COLORS[h.action_type] ?? "bg-gray-700 text-gray-300"
                }`}
              >
                {h.action_type}
              </span>
              <span className="rounded-full bg-gray-700/60 px-2 py-0.5 text-[10px] text-gray-400">
                {h.mode}
              </span>
              <span
                className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                  h.delivery === "verbatim"
                    ? "bg-sky-500/15 text-sky-300"
                    : "bg-amber-500/15 text-amber-300"
                }`}
                title={
                  h.delivery === "verbatim"
                    ? "Spoken word-for-word"
                    : "Reworded by the agent in its own voice"
                }
              >
                {h.delivery === "verbatim" ? "verbatim" : "reword"}
              </span>
              <span className="text-[10px] text-gray-600">p{h.priority}</span>
            </div>
            {h.description && (
              <p className="mt-0.5 truncate text-xs text-gray-500">{h.description}</p>
            )}
            {h.response_template && (
              <p className="mt-0.5 truncate text-xs text-gray-400 italic">
                → {h.response_template}
              </p>
            )}
          </div>

          <div className="flex shrink-0 gap-1">
            <button
              onClick={() => {
                setDraft({
                  id: h.id,
                  name: h.name,
                  intent_key: h.intent_key,
                  description: h.description,
                  response_template: h.response_template,
                  action_type: h.action_type,
                  delivery: h.delivery,
                  tags: h.tags ?? [],
                  mode: h.mode,
                  priority: h.priority,
                  enabled: h.enabled,
                });
              }}
              className="rounded p-1.5 text-gray-500 transition hover:bg-gray-700 hover:text-gray-200"
              title="Edit"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
            <button
              onClick={() => handleDuplicate(h.id)}
              className="rounded p-1.5 text-gray-500 transition hover:bg-gray-700 hover:text-indigo-300"
              title="Duplicate"
            >
              <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M8 7v8a2 2 0 002 2h6M8 7V5a2 2 0 012-2h4.586a1 1 0 01.707.293l4.414 4.414a1 1 0 01.293.707V15a2 2 0 01-2 2h-2M8 7H6a2 2 0 00-2 2v10a2 2 0 002 2h8a2 2 0 002-2v-2" />
              </svg>
            </button>
            <button
              onClick={() => handleDelete(h.id)}
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

      {/* Pagination */}
      {!loading && filtered.length > PAGE_SIZE && (
        <div className="flex items-center justify-between gap-2 border-t border-gray-700 px-4 py-2.5">
          <p className="text-[11px] text-gray-500">
            {(pageClamped - 1) * PAGE_SIZE + 1}–{Math.min(pageClamped * PAGE_SIZE, filtered.length)} of {filtered.length}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={pageClamped === 1}
              className="rounded-lg border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition hover:bg-gray-700 disabled:opacity-40"
            >
              Prev
            </button>
            <span className="px-1 py-1 text-xs text-gray-500">
              {pageClamped} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={pageClamped === totalPages}
              className="rounded-lg border border-gray-700 px-2.5 py-1 text-xs text-gray-300 transition hover:bg-gray-700 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}

      {/* Add/Edit modal */}
      {draft && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center p-4" onClick={() => setDraft(null)}>
          <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-700 bg-gray-900 p-5 shadow-2xl space-y-3"
          >
            <h3 className="text-base font-bold text-white">
              {draft.id ? "Edit Scenario" : "New Scenario"}
            </h3>

            <div>
              <label className="mb-1 block text-xs text-gray-400">Name</label>
              <input
                className={inputCls}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                placeholder="Pricing Question"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-gray-400">
                When should the agent use this?
              </label>
              <textarea
                className={inputCls + " resize-none"}
                rows={2}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                placeholder="Describe the moment in plain words — e.g. “when the customer asks how much it costs”."
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-gray-400">
                Response{" "}
                <span className="text-gray-600">
                  {draft.delivery === "verbatim"
                    ? "(spoken word-for-word — write the exact line)"
                    : "(briefing — the agent rewords this in its own voice)"}
                </span>
              </label>
              <textarea
                className={inputCls + " resize-none"}
                rows={3}
                value={draft.response_template}
                onChange={(e) => setDraft({ ...draft, response_template: e.target.value })}
                placeholder={
                  draft.delivery === "verbatim"
                    ? "The wagering requirement is forty times the deposit."
                    : "Acknowledge kindly and offer to text the details."
                }
              />
            </div>

            <div>
              <label className="mb-1 block text-xs text-gray-400">Delivery</label>
              <div className="flex gap-2">
                {(["verbatim", "reword"] as const).map((d) => (
                  <button
                    key={d}
                    type="button"
                    onClick={() => setDraft({ ...draft, delivery: d })}
                    className={`flex-1 rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                      draft.delivery === d
                        ? d === "verbatim"
                          ? "border-sky-500 bg-sky-500/15 text-sky-300"
                          : "border-amber-500 bg-amber-500/15 text-amber-300"
                        : "border-gray-700 text-gray-400 hover:bg-gray-800"
                    }`}
                  >
                    {d === "verbatim" ? "Verbatim (say exactly)" : "Reword (agent rephrases)"}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="mb-1 block text-xs text-gray-400">
                Priority <span className="text-gray-600">(lower wins when two could apply)</span>
              </label>
              <input
                className={inputCls}
                type="number"
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) || 100 })}
              />
            </div>

            {/* Tags — optional, only once the scenario exists */}
            {draft.id && (
              <div>
                <label className="mb-1 block text-xs text-gray-400">
                  Tags <span className="text-gray-600">(optional — for organizing &amp; filtering)</span>
                </label>
                {draft.tags.length > 0 && (
                  <div className="mb-1.5 flex flex-wrap gap-1.5">
                    {draft.tags.map((t) => (
                      <button
                        key={t}
                        onClick={() => removeTag(t)}
                        className="inline-flex items-center gap-1 rounded-full bg-purple-500/15 px-2 py-0.5 text-[11px] font-medium text-purple-300 hover:bg-purple-500/25"
                        title="Remove tag"
                      >
                        {t}
                        <span className="text-purple-400">×</span>
                      </button>
                    ))}
                  </div>
                )}
                <div className="flex gap-2">
                  <input
                    className={inputCls}
                    value={newTag}
                    onChange={(e) => setNewTag(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addTag(newTag);
                      }
                    }}
                    placeholder="Add a tag and press Enter"
                  />
                  <button
                    type="button"
                    onClick={() => addTag(newTag)}
                    disabled={!newTag.trim()}
                    className="shrink-0 rounded-md border border-gray-700 px-3 py-1.5 text-xs text-gray-300 transition hover:bg-gray-800 disabled:opacity-40"
                  >
                    Add
                  </button>
                </div>
                {allTags.filter((t) => !draft.tags.includes(t)).length > 0 && (
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {allTags
                      .filter((t) => !draft.tags.includes(t))
                      .map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() => addTag(t)}
                          className="rounded-full border border-gray-700 px-2 py-0.5 text-[10px] text-gray-400 transition hover:bg-gray-800 hover:text-gray-200"
                        >
                          + {t}
                        </button>
                      ))}
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setDraft(null)}
                disabled={saving}
                className="flex-1 rounded-lg border border-gray-700 px-4 py-2 text-sm font-medium text-gray-300 transition hover:bg-gray-800 disabled:opacity-40"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveDraft}
                disabled={saving || !draft.name.trim()}
                className="flex-1 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-indigo-500 disabled:opacity-40"
              >
                {saving ? "Saving..." : draft.id ? "Save Changes" : "Add Scenario"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
