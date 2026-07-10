"use client";

// Global command-style search. Extracted from the sidebar (2026-06-16 hybrid-nav) so it can
// live in the top bar AND still be used anywhere. Searches pages, live campaigns, and knowledge
// bases; debounced; grouped results; full keyboard nav (↑/↓/Enter/Esc). Behavior unchanged.

import { useRouter } from "next/navigation";
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Search, X, Megaphone, PhoneOff, BookOpen, Phone, LayoutDashboard, BarChart2,
  Settings, AppWindow, Trash2, Globe2, Activity, Users, ClipboardCheck,
} from "lucide-react";
import { fetchCampaignsV2 } from "@/lib/campaignV2Client";

const allPages = [
  { label: "Workers",        href: "/workers",         icon: Globe2,         description: "Worker fleet and world-time view" },
  { label: "Live Activity",  href: "/activity",        icon: Activity,       description: "Live operations console: calls, SMS, outcomes" },
  { label: "Reviews",        href: "/reviews",         icon: ClipboardCheck, description: "Label call quality: good/bad verdicts that calibrate the AI judge" },
  { label: "Campaigns",      href: "/campaigns",       icon: Megaphone,      description: "Manage your calling campaigns" },
  { label: "Audience",       href: "/audience",        icon: Users,          description: "Recycled local segments carved from past outcomes" },
  { label: "Do Not Call",    href: "/do-not-call",     icon: PhoneOff,       description: "DNC list management" },
  { label: "Knowledge Bases",href: "/knowledge-bases", icon: BookOpen,       description: "Knowledge base documents" },
  { label: "Phone Numbers",  href: "/phone-numbers",   icon: Phone,          description: "Phone number management" },
  { label: "Analytics",      href: "/analytics",       icon: BarChart2,      description: "Reports and analytics" },
  { label: "App Center",     href: "/app-center",      icon: AppWindow,      description: "Integrations and apps" },
  { label: "Settings",       href: "/settings",        icon: Settings,       description: "Account settings" },
  { label: "Dashboard",      href: "/dashboard",       icon: LayoutDashboard, description: "Home dashboard" },
  { label: "Deleted History",href: "/deleted-history", icon: Trash2,          description: "Archived and deleted items" },
];

const staticKnowledgeBases = [
  { id: 1, name: "Lucky 7 RND campaign" },
  { id: 2, name: "Lucky7even (FAQ / Objection Handling)" },
  { id: 3, name: "Test" },
];

const categoryOrder = ["Page", "Campaign", "Knowledge Base"] as const;

interface SearchResult {
  id: string;
  label: string;
  description?: string;
  href: string;
  category: "Page" | "Campaign" | "Knowledge Base";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  icon?: any;
}

interface GlobalSearchProps {
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export default function GlobalSearch({ inputRef: externalInputRef }: GlobalSearchProps = {}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const containerRef = useRef<HTMLDivElement>(null);

  const search = useCallback(async (q: string) => {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) { setResults([]); setLoading(false); return; }
    setLoading(true);

    const pageResults: SearchResult[] = allPages
      .filter((p) => p.label.toLowerCase().includes(trimmed) || p.description.toLowerCase().includes(trimmed))
      .map((p) => ({ id: `page-${p.href}`, label: p.label, description: p.description, href: p.href, category: "Page" as const, icon: p.icon }));

    const kbResults: SearchResult[] = staticKnowledgeBases
      .filter((kb) => kb.name.toLowerCase().includes(trimmed))
      .map((kb) => ({ id: `kb-${kb.id}`, label: kb.name, description: "Knowledge Base", href: "/knowledge-bases", category: "Knowledge Base" as const, icon: BookOpen }));

    let campaignResults: SearchResult[] = [];
    try {
      const campaigns = await fetchCampaignsV2();
      campaignResults = campaigns
        .filter((c) => (c.name as string).toLowerCase().includes(trimmed))
        .slice(0, 5)
        .map((c) => ({ id: `campaign-${c.id}`, label: c.name as string, description: `Status: ${c.status as string}`, href: `/campaigns/v2/${c.id}`, category: "Campaign" as const, icon: Megaphone }));
    } catch { /* silent */ }

    setResults([...pageResults, ...kbResults, ...campaignResults]);
    setLoading(false);
  }, []);

  // Debounce search on query change. The effect ONLY schedules the timer (no synchronous setState
  // in its body); loading/empty state is set in onQueryChange and results inside search() (run from
  // the timer) — keeps setState out of the effect body (react-hooks/set-state-in-effect).
  useEffect(() => {
    if (!query.trim()) return;
    const t = setTimeout(() => search(query), 300);
    return () => clearTimeout(t);
  }, [query, search]);

  function onQueryChange(value: string) {
    setQuery(value);
    setOpen(true);
    setActiveIndex(0);
    if (!value.trim()) { setResults([]); setLoading(false); } else { setLoading(true); }
  }

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIndex((i) => Math.min(i + 1, results.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIndex((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); const r = results[activeIndex]; if (r) navigate(r.href); }
    else if (e.key === "Escape") { setOpen(false); inputRef.current?.blur(); }
  }

  function navigate(href: string) { router.push(href); setOpen(false); setQuery(""); setResults([]); }
  function clear() { setQuery(""); setResults([]); inputRef.current?.focus(); }

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.category]) acc[r.category] = [];
    acc[r.category].push(r);
    return acc;
  }, {});

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onKeyDown={handleKeyDown}
          placeholder="Search campaigns, pages…"
          className="w-full pl-7 pr-7 py-1.5 text-xs bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500 transition-all"
          autoComplete="off"
        />
        {query && (
          <button onClick={clear} className="absolute right-2 top-1/2 -translate-y-1/2 text-[var(--text-3)] hover:text-[var(--text-2)] transition-colors">
            <X size={12} />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-[var(--bg-card)] border border-[var(--border)] rounded-xl shadow-2xl overflow-hidden">
          {loading ? (
            <div className="px-4 py-5 flex items-center justify-center gap-2">
              <div className="w-3 h-3 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-[var(--text-2)]">Searching…</span>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-5 text-center">
              <p className="text-xs text-[var(--text-2)]">No results for &ldquo;{query}&rdquo;</p>
            </div>
          ) : (
            <div className="max-h-72 overflow-y-auto py-1">
              {categoryOrder.map((cat) => {
                const items = grouped[cat];
                if (!items?.length) return null;
                return (
                  <div key={cat}>
                    <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-wider">{cat}s</p>
                    {items.map((result) => {
                      const globalIndex = results.indexOf(result);
                      const Icon = result.icon;
                      return (
                        <button key={result.id} onClick={() => navigate(result.href)} onMouseEnter={() => setActiveIndex(globalIndex)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${globalIndex === activeIndex ? "bg-blue-600/20" : "hover:bg-[var(--bg-hover)]"}`}>
                          <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${globalIndex === activeIndex ? "bg-blue-500/20" : "bg-[var(--bg-elevated)]"}`}>
                            <Icon size={12} className={globalIndex === activeIndex ? "text-blue-400" : "text-[var(--text-2)]"} />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-medium truncate ${globalIndex === activeIndex ? "text-blue-300" : "text-[var(--text-1)]"}`}>{result.label}</p>
                            {result.description && <p className="text-[10px] text-[var(--text-3)] truncate mt-0.5">{result.description}</p>}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              <p className="px-3 py-2 text-[10px] text-[var(--text-3)] border-t border-[var(--border)] mt-1">↑↓ navigate · Enter to select · Esc to close</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
