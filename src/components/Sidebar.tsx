"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Bell, Search, Megaphone, PhoneOff, BookOpen, Phone, X,
  LayoutDashboard, BarChart2, Settings, AppWindow, Sun, Moon, Trash2, Globe2,
  Activity, Users, Lock, LockOpen, ClipboardCheck,
} from "lucide-react";

const CampaignIcon = Megaphone;
import { useNotifications } from "@/lib/notificationsContext";
import { useTheme } from "@/lib/themeContext";
import { fetchCampaignsV2 } from "@/lib/campaignV2Client";
// Animated sidebar nav icons (lucide-animated.com, motion-powered). These run
// only on the desktop nav; mobile + search keep the static lucide-react icons.
import { useReducedMotion } from "motion/react";
import { LayoutGridIcon } from "@/components/icons/animated/layout-grid";
import { ActivityIcon } from "@/components/icons/animated/activity";
import { EarthIcon } from "@/components/icons/animated/earth";
import { SendIcon } from "@/components/icons/animated/send";
import { UsersIcon } from "@/components/icons/animated/users";
import { PhoneMissedIcon } from "@/components/icons/animated/phone-missed";
import { BookTextIcon } from "@/components/icons/animated/book-text";
import { ClipboardCheckIcon } from "@/components/icons/animated/clipboard-check";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/icons/animated/types";

// P2 Option C (2026-05-22): semantic-accents-only. All inactive nav chips
// neutralize except Do Not Call, which keeps the red warning hue as the one
// color in the sidebar that carries safety meaning. Active state stays blue
// regardless (desktop) or red-for-DNC + blue-otherwise (mobile bottom nav).
//
// `icon` (static lucide-react) drives mobile nav + search; `animatedIcon` drives
// the desktop nav rows. lucide-animated has no exact twin for LayoutDashboard /
// Megaphone / PhoneOff / BookOpen, so those map to the nearest animated icon.
const navItems: {
  label: string; href: string; icon: typeof Activity; animatedIcon: AnimatedIcon; color: string; bg: string;
}[] = [
  { label: "Dashboard",     href: "/dashboard",       icon: LayoutDashboard, animatedIcon: LayoutGridIcon,  color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Live Activity", href: "/activity",        icon: Activity,        animatedIcon: ActivityIcon,    color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Workers",       href: "/workers",         icon: Globe2,          animatedIcon: EarthIcon,       color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Campaigns",     href: "/campaigns",       icon: Megaphone,       animatedIcon: SendIcon,        color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Reviews",       href: "/reviews",         icon: ClipboardCheck,  animatedIcon: ClipboardCheckIcon, color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Audience",      href: "/audience",        icon: Users,           animatedIcon: UsersIcon,       color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
  { label: "Do Not Call",   href: "/do-not-call",     icon: PhoneOff,        animatedIcon: PhoneMissedIcon, color: "text-red-400",         bg: "bg-red-500/10"           },
  { label: "Knowledge",     href: "/knowledge-bases", icon: BookOpen,        animatedIcon: BookTextIcon,    color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" },
];

const SIDEBAR_LOCK_KEY = "voizo-sidebar-locked";

const allPages = [
  { label: "Workers",        href: "/workers",         icon: Globe2,         description: "Worker fleet and world-time view" },
  { label: "Live Activity",  href: "/activity",        icon: Activity,       description: "Live operations console — calls, SMS, outcomes" },
  { label: "Reviews",        href: "/reviews",         icon: ClipboardCheck, description: "Label call quality — good/bad verdicts that calibrate the AI judge" },
  { label: "Campaigns",      href: "/campaigns",       icon: Megaphone,      description: "Manage your calling campaigns" },
  { label: "Audience",       href: "/audience",        icon: Users,          description: "Recycled local segments carved from past outcomes" },
  { label: "Do Not Call",    href: "/do-not-call",     icon: PhoneOff,       description: "DNC list management" },
  { label: "Knowledge Bases",href: "/knowledge-bases", icon: BookOpen,       description: "Knowledge base documents" },
  { label: "Phone Numbers",  href: "/phone-numbers",   icon: Phone,          description: "Phone number management" },
  { label: "Analytics",      href: "/analytics",       icon: BarChart2,      description: "Reports and analytics" },
  { label: "App Center",     href: "/app-center",      icon: AppWindow,      description: "Integrations and apps" },
  { label: "Settings",       href: "/settings",        icon: Settings,       description: "Account settings" },
  { label: "Dashboard",        href: "/dashboard",        icon: LayoutDashboard, description: "Home dashboard" },
  { label: "Deleted History",  href: "/deleted-history",  icon: Trash2,          description: "Archived and deleted items" },
];

const staticKnowledgeBases = [
  { id: 1, name: "Lucky 7 RND campaign" },
  { id: 2, name: "Lucky7even (FAQ / Objection Handling)" },
  { id: 3, name: "Test" },
];

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

function GlobalSearch({ inputRef: externalInputRef }: GlobalSearchProps = {}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const inputRef = externalInputRef ?? internalInputRef;
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) { setResults([]); setLoading(false); return; }
    setLoading(true);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => { if (debounceRef.current) clearTimeout(debounceRef.current); };
  }, [query, search]);

  useEffect(() => { setActiveIndex(0); }, [results]);

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
  const categoryOrder = ["Page", "Campaign", "Knowledge Base"] as const;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)] pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => { if (query.trim()) setOpen(true); }}
          onKeyDown={handleKeyDown}
          placeholder="Global Search"
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

function NotificationBell({ size = 18 }: { size?: number }) {
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleOpen() { setOpen((v) => !v); if (!open && unreadCount > 0) markAllRead(); }

  return (
    <div ref={ref} className="relative">
      <button onClick={handleOpen} className="relative p-1 text-[var(--text-2)] hover:text-[var(--text-1)] transition-colors">
        <Bell size={size} />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[15px] h-[15px] px-0.5 bg-blue-500 rounded-full flex items-center justify-center text-white text-[8px] font-bold leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-80 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-1)]">Notifications</span>
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold bg-blue-500 text-white">{unreadCount}</span>
              )}
            </div>
            {notifications.length > 0 && unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">Mark all read</button>
            )}
          </div>

          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-10 gap-2">
              <div className="w-10 h-10 rounded-full bg-[var(--bg-elevated)] flex items-center justify-center">
                <Bell size={18} className="text-[var(--text-3)]" />
              </div>
              <p className="text-xs text-[var(--text-2)] font-medium">No notifications yet</p>
              <p className="text-[11px] text-[var(--text-3)] text-center">Activity will appear here</p>
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto divide-y divide-[var(--border)]">
              {notifications.map((n) => {
                const isDnc = n.message.toLowerCase().includes("dnc") || n.message.toLowerCase().includes("phone number");
                const isKb = n.message.toLowerCase().includes("knowledge");
                const Icon = isDnc ? PhoneOff : isKb ? BookOpen : CampaignIcon;
                const iconColor = isDnc ? "text-red-400" : isKb ? "text-indigo-400" : "text-blue-400";
                const iconBg = isDnc ? "bg-red-500/10" : isKb ? "bg-indigo-500/10" : "bg-blue-500/10";
                return (
                  <li key={n.id} className={`flex items-start gap-3 px-4 py-3 transition-colors ${n.read ? "" : "bg-blue-500/5"}`}>
                    <div className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${n.read ? "bg-[var(--bg-elevated)]" : iconBg}`}>
                      <Icon size={13} className={n.read ? "text-[var(--text-3)]" : iconColor} />
                    </div>
                    <div className="flex-1 min-w-0 pt-0.5">
                      <p className={`text-xs leading-snug ${n.read ? "text-[var(--text-2)]" : "text-[var(--text-1)] font-medium"}`}>{n.message}</p>
                      <p className="text-[10px] text-[var(--text-3)] mt-1">{n.time}</p>
                    </div>
                    {!n.read && <span className="mt-2 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

// A single desktop nav row. Owns a ref to its animated icon and plays the
// animation while the whole row is hovered (not just the 14px glyph). Honors
// the user's reduced-motion preference — no animation when reduce is set.
function NavRow({ item, isActive, collapsed }: {
  item: (typeof navItems)[number];
  isActive: boolean;
  collapsed: boolean;
}) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  const reduce = useReducedMotion();
  const Icon = item.animatedIcon;
  return (
    <li>
      <Link
        href={item.href}
        title={collapsed ? item.label : undefined}
        onMouseEnter={() => { if (!reduce) iconRef.current?.startAnimation(); }}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        className={`flex items-center ${collapsed ? "justify-center px-1.5" : "gap-3 px-3"} py-2.5 rounded-lg text-sm font-medium transition-all ${
          isActive
            ? "bg-blue-600 text-white shadow-md shadow-blue-600/25"
            : "text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]"
        }`}
      >
        <div className={`w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0 ${isActive ? "bg-white/15" : item.bg}`}>
          <Icon ref={iconRef} size={14} className={isActive ? "text-white" : item.color} />
        </div>
        {!collapsed && item.label}
      </Link>
    </li>
  );
}

interface SidebarContentProps {
  collapsed: boolean;
  locked: boolean;
  setLocked: (locked: boolean) => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  onSearchIconClick: () => void;
}

function SidebarContent({
  collapsed, locked, setLocked, searchInputRef, onSearchIconClick,
}: SidebarContentProps) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center px-3 py-3 border-b border-[var(--border)] ${collapsed ? "justify-center flex-col gap-1" : "gap-3"}`}>
        <Link href="/workers" className={`flex items-center group ${collapsed ? "flex-col gap-1" : "gap-3"}`}>
          <div className="w-11 h-11 bg-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-600/20 group-hover:bg-blue-500 group-hover:shadow-blue-500/30 transition-all flex-shrink-0">
            <span className="text-white text-base font-bold">V</span>
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-none">
              <span className="font-bold text-[var(--text-1)] text-sm">VOIZO</span>
              <span className="text-[9px] tracking-wider uppercase text-[var(--text-3)] mt-0.5">DIALER</span>
            </div>
          )}
        </Link>
        {collapsed && (
          <span className="text-[9px] tracking-wider uppercase text-[var(--text-3)] leading-none">DIALER</span>
        )}
      </div>

      <div className={`border-b border-[var(--border)] ${collapsed ? "px-2 py-2" : "px-3 py-3"}`}>
        {collapsed ? (
          <button
            type="button"
            title="Search"
            aria-label="Open search"
            onClick={onSearchIconClick}
            className="w-full flex items-center justify-center py-2 rounded-lg text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)] transition-colors"
          >
            <Search size={16} />
          </button>
        ) : (
          <GlobalSearch inputRef={searchInputRef} />
        )}
      </div>

      <nav className="flex-1 px-2 py-3 overflow-y-auto">
        {!collapsed && (
          <p className="px-2 mb-2 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-widest">Menu</p>
        )}
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
            return <NavRow key={item.href} item={item} isActive={isActive} collapsed={collapsed} />;
          })}
        </ul>
      </nav>

      <div className={`border-t border-[var(--border)] ${collapsed ? "px-2 py-2 flex justify-center" : "px-3 py-2 flex justify-end"}`}>
        <button
          type="button"
          onClick={() => setLocked(!locked)}
          title={locked ? "Unlock — auto-collapse on mouse-leave" : "Lock sidebar open"}
          aria-pressed={locked}
          className={`flex items-center gap-1.5 rounded-lg transition-all ${
            collapsed ? "w-7 h-7 justify-center" : "px-2 py-1.5"
          } ${
            locked
              ? "bg-[var(--bg-card)] border border-[var(--border-2)] text-[var(--text-1)]"
              : "border border-[var(--border)] text-[var(--text-3)] hover:text-[var(--text-1)] hover:border-[var(--border-2)]"
          }`}
        >
          {locked ? <Lock size={12} /> : <LockOpen size={12} />}
          {!collapsed && (
            <span className="text-[10px] tracking-wide uppercase">
              {locked ? "Locked" : "Auto"}
            </span>
          )}
        </button>
      </div>

    </div>
  );
}

function MobileTopBar() {
  const pathname = usePathname();
  const { isDark, toggle } = useTheme();
  const current = navItems.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  const pageTitle = current?.label ?? "Dashboard";
  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 bg-[var(--bg-sidebar)] border-b border-[var(--border)]">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-blue-600 rounded-lg flex items-center justify-center">
          <span className="text-white text-xs font-bold">V</span>
        </div>
        <span className="font-semibold text-[var(--text-1)] text-sm">{pageTitle}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={toggle} className="p-1.5 rounded-lg text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors">
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <NotificationBell size={20} />
        <div className="w-7 h-7 bg-gradient-to-br from-blue-500 to-blue-700 rounded-full flex items-center justify-center">
          <span className="text-white text-[10px] font-bold">V</span>
        </div>
      </div>
    </div>
  );
}

function MobileBottomNav() {
  const pathname = usePathname();
  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-[var(--bg-sidebar)] border-t border-[var(--border)] flex items-center">
      {navItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.animatedIcon;
        // P2 Option C: active mobile-tab is blue by default, red for DNC.
        // Can't reuse item.color here — desktop chips share that field for
        // the neutralized inactive chip, which would render gray-on-gray
        // when active on mobile. Keep the active signal strong.
        const activeColor = item.href === "/do-not-call" ? "text-red-400" : "text-blue-400";
        return (
          <Link key={item.href} href={item.href}
            className={`flex-1 flex flex-col items-center justify-center py-2.5 gap-0.5 transition-colors ${isActive ? activeColor : "text-[var(--text-3)] hover:text-[var(--text-2)]"}`}>
            <Icon size={19} />
            <span className="text-[10px] font-medium leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default function Sidebar() {
  const [locked, setLocked] = useState<boolean>(() => {
    // Lazy initializer reads localStorage on first mount (client-only via
    // "use client") — avoids first-paint flash. Mirrors the pattern in
    // src/app/workers/CollapsibleColumn.tsx:38-46.
    try {
      const v = localStorage.getItem(SIDEBAR_LOCK_KEY);
      if (v === "true") return true;
      if (v === "false") return false;
    } catch { /* ignore — fall through to default */ }
    return false; // default AUTO (collapsed)
  });
  const [hovered, setHovered] = useState(false);
  const collapsed = !locked && !hovered;

  useEffect(() => {
    try { localStorage.setItem(SIDEBAR_LOCK_KEY, String(locked)); }
    catch { /* ignore */ }
  }, [locked]);

  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const pendingSearchFocusRef = useRef(false);

  useEffect(() => {
    // When the sidebar transitions from collapsed→expanded because the user
    // clicked the Search icon, focus the input after it renders.
    if (!collapsed && pendingSearchFocusRef.current) {
      pendingSearchFocusRef.current = false;
      // Defer one frame so the input has mounted and width animation has begun.
      requestAnimationFrame(() => { searchInputRef.current?.focus(); });
    }
  }, [collapsed]);

  return (
    <>
      <MobileTopBar />
      <MobileBottomNav />
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="hidden md:flex bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex-col h-screen overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]"
        style={{ width: collapsed ? 64 : 240 }}
      >
        <SidebarContent
          collapsed={collapsed}
          locked={locked}
          setLocked={setLocked}
          searchInputRef={searchInputRef}
          onSearchIconClick={() => {
            pendingSearchFocusRef.current = true;
            setLocked(true);
          }}
        />
      </aside>
    </>
  );
}
