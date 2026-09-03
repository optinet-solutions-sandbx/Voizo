"use client";

// The campaign picker: one control, two homes. It began life inside GlobalPerformance.tsx as a
// local MultiSelect and moved here on 2026-09-03 so Campaign Performance can offer the same
// "All campaigns (N)" picker the dashboard mockup has (Val's team, 2026-09-03: "the options to
// select the campaigns are not showing in Campaign Performance"). Nothing in the picker
// changed in the move; only its address did.

import { useCallback, useEffect, useRef, useState } from "react";
import { Search } from "lucide-react";
import { groupCampaignOptions, CHILD_PAGE_SIZE, type GroupableOption } from "@/lib/campaignGroups";
import { matchesCampaignName, toggleAllMatching } from "./campaignFilters";

// Trigger/panel styling mirrors StyledSelect so the bar is visually uniform.
const TRIGGER_CLS =
  // Elevated surface, not the app's darkest ground (Jasiel 2026-09-03: the dark triggers read as
  // high contrast inside a card); StyledSelect's compact size paints the same.
  "w-full flex items-center justify-between gap-2 pl-3.5 pr-3 py-2.5 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] text-sm text-left hover:border-primary/40 transition-all cursor-pointer";

// The checkbox glyph, shared by the group header (which can be half-selected) and the rows.
function Tick({ state }: { state: "on" | "off" | "mixed" }) {
  return (
    <span
      className={`mt-0.5 w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
        state === "off" ? "border-[var(--border-2)]" : "bg-primary border-primary text-white"
      }`}
    >
      {state === "on" && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      )}
      {/* "some of this group" — a dash, not a tick, so it cannot be misread as all of them. */}
      {state === "mixed" && <span className="block w-2 h-[2px] rounded bg-white" />}
    </span>
  );
}

export default function CampaignPicker({
  label,
  prefix,
  options,
  parentLabels,
  selected,
  onChange,
}: {
  label: string;
  /** Muted axis label inside the trigger ("Campaign:"), matching StyledSelect's prefix so a
   *  toolbar of controls reads "Axis: value" in one vocabulary (dashboard, 2026-09-03). */
  prefix?: string;
  // `search` is what a query is matched against (label + parent label + raw campaign name), so a
  // keyword works whether the operator types what they SEE or what's in the underlying name.
  options: GroupableOption[];
  // parent campaign id -> group header label. Empty = render flat (older API deploy).
  parentLabels: Record<string, string>;
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const [open, setOpen] = useState(false);
  // Which parent groups are expanded. Collapsed by default is the whole point: in the default
  // 7-day window all 63 options are children of just 10 parents (measured 2026-08-26).
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Groups the operator asked to see in full. A group opens CAPPED at CHILD_PAGE_SIZE
  // (Jasiel 2026-09-01): a recurring campaign spawns a child a day, so a 90-day window put
  // 96 dated rows under one parent in a box that shows about 7, and a search force-expands
  // every group at once. Collapsing a group drops it from here, so reopening starts capped.
  // Which PAGE of runs each open group shows (Jasiel 2026-09-03: pages, not "show all").
  const [kidPage, setKidPage] = useState<Map<string, number>>(new Map());
  // Keyword search over the options (Val's CRM team, 2026-08-26): 60+ near-identical
  // campaign names make "reactivation" the only practical way to reach a family of them.
  // Local state, deliberately NOT part of Filters — typing here costs no analytics refetch.
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  // Closing clears the query. Reopening onto a stale filtered list reads as "my campaigns
  // disappeared", and the selection it hides is still driving the KPIs.
  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
  }, []);
  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [close]);
  const toggle = (v: string) =>
    onChange(selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  // Same token-AND predicate as the Campaign Performance search (f902922): every whitespace-
  // separated token must appear, in any order, so "rnd au" works and a longer query only narrows.
  const shown = options.filter((o) => matchesCampaignName(o.search, query));
  const selectedSet = new Set(selected); // hit once per option AND once per match — build it once
  const allShownSelected = shown.length > 0 && shown.every((o) => selectedSet.has(o.value));
  const searching = query.trim().length > 0;
  // Group AFTER filtering, so a search hides whole groups that have no match — and while a query
  // is active every surviving group is force-expanded (a collapsed hit reads as "no results").
  const { groups, loose } = groupCampaignOptions(shown, parentLabels);
  const text = selected.length === 0 ? label : `${selected.length} selected`;
  return (
    <div
      ref={ref}
      className="relative min-w-[170px]"
      // Escape hands focus BACK to the trigger. Only on this path: the click-outside close
      // must leave focus wherever the user just clicked.
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        close();
        triggerRef.current?.focus();
      }}
    >
      <button ref={triggerRef} type="button" onClick={() => (open ? close() : setOpen(true))} aria-expanded={open} className={TRIGGER_CLS}>
        <span className="inline-flex items-center gap-2 min-w-0">
          {prefix && <span className="text-[var(--text-3)] shrink-0">{prefix}</span>}
          <span className={selected.length || prefix ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}>{text}</span>
        </span>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`text-[var(--text-3)] transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {open && (
        // The panel sizes to its content the way StyledSelect has since 3b30ed3 — this local
        // twin never got that fix, which is why every row read "Daily Automated Conversi…".
        // Only the option LIST scrolls, so the search box can't scroll out of reach.
        <div className="absolute z-50 mt-1.5 min-w-full w-max max-w-[min(90vw,28rem)] rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
          <div className="px-2 pb-1.5">
            <div className="relative">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-4)] pointer-events-none" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label="Search campaigns by keyword"
                placeholder="Search campaigns…"
                className="pl-7 pr-2 py-1.5 w-full text-[12.5px] rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] text-[var(--text-1)] placeholder-[var(--text-4)] focus:outline-none focus:border-primary"
              />
            </div>
          </div>
          {searching && shown.length > 0 && (
            // The actual ask: reach a whole family ("all reactivation") in one click instead of
            // ticking them one by one. Selections made under a different query are untouched.
            <button
              type="button"
              onClick={() => onChange(toggleAllMatching(selected, shown.map((o) => o.value)))}
              className="w-full flex items-center justify-between gap-3 px-3.5 py-1.5 text-[11.5px] border-y border-[var(--border)] text-primary hover:bg-[var(--bg-hover)] transition-colors"
            >
              <span>{allShownSelected ? `Deselect all ${shown.length}` : `Select all ${shown.length}`}</span>
              <span className="text-[var(--text-4)] font-mono">
                {shown.length} of {options.length}
              </span>
            </button>
          )}
          {/* 320px: a group header, its first CHILD_PAGE_SIZE runs AND the page footer all
              fit without scrolling. At the old 256px the button sat 30px below the fold, measured
              in the real app on 2026-09-02 — the way out of a capped list has to be on screen. */}
          <div className="max-h-80 overflow-y-auto">
            {shown.length === 0 ? (
              <div className="px-3.5 py-2.5 text-xs text-[var(--text-3)]">
                {options.length === 0 ? "No campaigns" : `No campaign matches “${query.trim()}”`}
              </div>
            ) : (
              <>
                {groups.map((g) => {
                  const ids = g.options.map((o) => o.value);
                  const on = ids.filter((v) => selectedSet.has(v)).length;
                  const isOpen = searching || expanded.has(g.key);
                  const kidPages = Math.max(1, Math.ceil(g.options.length / CHILD_PAGE_SIZE));
                  const kp = Math.min(kidPage.get(g.key) ?? 1, kidPages);
                  const kids = g.options.slice((kp - 1) * CHILD_PAGE_SIZE, kp * CHILD_PAGE_SIZE);
                  return (
                    <div key={g.key}>
                      {/* Sticky: with a long group open, the header scrolled away and left a
                          list of bare dates with nothing naming what they belong to. */}
                      <div className="w-full flex items-center gap-1 pl-1.5 pr-3 hover:bg-[var(--bg-hover)] transition-colors sticky top-0 z-10 bg-[var(--bg-card)]">
                        <button
                          type="button"
                          onClick={() => setExpanded((prev) => {
                            const next = new Set(prev);
                            if (next.has(g.key)) {
                              next.delete(g.key);
                              setKidPage((m) => { const n = new Map(m); n.delete(g.key); return n; });
                            } else next.add(g.key);
                            return next;
                          })}
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Collapse" : "Expand"} ${g.label}`}
                          className="p-1 text-[var(--text-4)] hover:text-[var(--text-2)] shrink-0"
                        >
                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${isOpen ? "rotate-90" : ""}`}>
                            <path d="m9 18 6-6-6-6" />
                          </svg>
                        </button>
                        {/* A parent is a HEADER, never a campaign id — ticking it selects its
                            children, which are what actually carry the calls. */}
                        <button
                          type="button"
                          role="checkbox"
                          aria-checked={on === ids.length ? "true" : on > 0 ? "mixed" : "false"}
                          onClick={() => onChange(toggleAllMatching(selected, ids))}
                          className="flex-1 flex items-start gap-2.5 py-2 text-sm text-left text-[var(--text-1)]"
                        >
                          <Tick state={on === ids.length ? "on" : on > 0 ? "mixed" : "off"} />
                          <span className="whitespace-normal break-words font-medium">{g.label}</span>
                        </button>
                        <span className="text-[11px] font-mono text-[var(--text-4)] shrink-0">
                          {on > 0 && on < ids.length ? `${on}/${ids.length}` : ids.length}
                        </span>
                      </div>
                      {isOpen &&
                        kids.map((o) => (
                          <button
                            key={o.value}
                            type="button"
                            onClick={() => toggle(o.value)}
                            aria-pressed={selectedSet.has(o.value)}
                            className="w-full flex items-center gap-2.5 pl-9 pr-3.5 py-1.5 text-[13px] text-left text-[var(--text-2)] hover:bg-[var(--bg-hover)] transition-colors"
                          >
                            <Tick state={selectedSet.has(o.value) ? "on" : "off"} />
                            {/* The header already carries country, name and brand — the child
                                only has to say which RUN it is. */}
                            <span className="font-mono">{o.runLabel || o.label}</span>
                          </button>
                        ))}
                      {isOpen && kidPages > 1 && (
                        // Pages of runs, the group's TOTAL always stated: the same footer the
                        // Campaign Performance families use.
                        <div className="flex items-center justify-between pl-9 pr-3 py-1.5 text-[11px] text-[var(--text-3)]">
                          <span>Showing {(kp - 1) * CHILD_PAGE_SIZE + 1}–{Math.min(kp * CHILD_PAGE_SIZE, g.options.length)} of {g.options.length} runs</span>
                          <span className="inline-flex items-center gap-1">
                            <button type="button" disabled={kp <= 1} onClick={() => setKidPage((m) => new Map(m).set(g.key, kp - 1))} aria-label={`${g.label}: previous runs`} className="w-6 h-6 rounded-md border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">‹</button>
                            <span className="font-mono">{kp} / {kidPages}</span>
                            <button type="button" disabled={kp >= kidPages} onClick={() => setKidPage((m) => new Map(m).set(g.key, kp + 1))} aria-label={`${g.label}: next runs`} className="w-6 h-6 rounded-md border border-[var(--border)] hover:bg-[var(--bg-hover)] disabled:opacity-40 disabled:cursor-not-allowed">›</button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {groups.length > 0 && loose.length > 0 && (
                  <div className="px-3.5 pt-2 pb-1 text-[10.5px] uppercase tracking-wide text-[var(--text-4)]">
                    One-off campaigns
                  </div>
                )}
                {loose.map((o) => {
                  const on = selectedSet.has(o.value);
                  return (
                    <button
                      key={o.value}
                      type="button"
                      onClick={() => toggle(o.value)}
                      aria-pressed={on}
                      className="w-full flex items-start gap-2.5 px-3.5 py-2 text-sm text-left text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-colors"
                    >
                      <Tick state={on ? "on" : "off"} />
                      {/* Wraps rather than truncates: the AU/CA/NZ discriminator sits at the END. */}
                      <span className="whitespace-normal break-words">{o.label}</span>
                    </button>
                  );
                })}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
