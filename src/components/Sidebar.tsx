"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useRef, useState, useEffect, useCallback } from "react";
import {
  Bell,
  Search,
  Megaphone,
  PhoneOff,
  BookOpen,
  Phone,
  X,
  LayoutDashboard,
  BarChart2,
  Settings,
  AppWindow,
} from "lucide-react";

const CampaignIcon = Megaphone;
import { useNotifications } from "@/lib/notificationsContext";
import { fetchCampaigns } from "@/lib/campaignData";

const navItems = [
  { label: "Campaigns", href: "/campaigns", icon: Megaphone },
  { label: "Do Not Call", href: "/do-not-call", icon: PhoneOff },
  { label: "Knowledge", href: "/knowledge-bases", icon: BookOpen },
  { label: "Phone Number", href: "/phone-numbers", icon: Phone },
];

// All searchable pages
const allPages = [
  { label: "Campaigns", href: "/campaigns", icon: Megaphone, description: "Manage your calling campaigns" },
  { label: "Do Not Call", href: "/do-not-call", icon: PhoneOff, description: "DNC list management" },
  { label: "Knowledge Bases", href: "/knowledge-bases", icon: BookOpen, description: "Knowledge base documents" },
  { label: "Phone Numbers", href: "/phone-numbers", icon: Phone, description: "Phone number management" },
  { label: "Analytics", href: "/analytics", icon: BarChart2, description: "Reports and analytics" },
  { label: "App Center", href: "/app-center", icon: AppWindow, description: "Integrations and apps" },
  { label: "Settings", href: "/settings", icon: Settings, description: "Account settings" },
  { label: "Dashboard", href: "/", icon: LayoutDashboard, description: "Home dashboard" },
];

// Static knowledge bases (mirrors initial data in knowledge-bases page)
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

function GlobalSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    const trimmed = q.trim().toLowerCase();
    if (!trimmed) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);

    // Search pages
    const pageResults: SearchResult[] = allPages
      .filter(
        (p) =>
          p.label.toLowerCase().includes(trimmed) ||
          p.description.toLowerCase().includes(trimmed)
      )
      .map((p) => ({
        id: `page-${p.href}`,
        label: p.label,
        description: p.description,
        href: p.href,
        category: "Page" as const,
        icon: p.icon,
      }));

    // Search knowledge bases
    const kbResults: SearchResult[] = staticKnowledgeBases
      .filter((kb) => kb.name.toLowerCase().includes(trimmed))
      .map((kb) => ({
        id: `kb-${kb.id}`,
        label: kb.name,
        description: "Knowledge Base",
        href: "/knowledge-bases",
        category: "Knowledge Base" as const,
        icon: BookOpen,
      }));

    // Fetch campaigns from Supabase
    let campaignResults: SearchResult[] = [];
    try {
      const campaigns = await fetchCampaigns();
      campaignResults = campaigns
        .filter((c) => c.name.toLowerCase().includes(trimmed))
        .slice(0, 5)
        .map((c) => ({
          id: `campaign-${c.id}`,
          label: c.name,
          description: `Status: ${c.status} · ${c.totalContacts} contacts`,
          href: `/campaigns/${c.id}`,
          category: "Campaign" as const,
          icon: Megaphone,
        }));
    } catch {
      // Supabase may not be configured — silently skip
    }

    setResults([...pageResults, ...kbResults, ...campaignResults]);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (!query.trim()) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    debounceRef.current = setTimeout(() => search(query), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, search]);

  // Reset active index when results change
  useEffect(() => {
    setActiveIndex(0);
  }, [results]);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (!open || results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const r = results[activeIndex];
      if (r) navigate(r.href);
    } else if (e.key === "Escape") {
      setOpen(false);
      inputRef.current?.blur();
    }
  }

  function navigate(href: string) {
    router.push(href);
    setOpen(false);
    setQuery("");
    setResults([]);
  }

  function clear() {
    setQuery("");
    setResults([]);
    inputRef.current?.focus();
  }

  const grouped = results.reduce<Record<string, SearchResult[]>>((acc, r) => {
    if (!acc[r.category]) acc[r.category] = [];
    acc[r.category].push(r);
    return acc;
  }, {});

  const categoryOrder = ["Page", "Campaign", "Knowledge Base"] as const;

  return (
    <div ref={containerRef} className="relative">
      <div className="relative">
        <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          onFocus={() => {
            if (query.trim()) setOpen(true);
          }}
          onKeyDown={handleKeyDown}
          placeholder="Global Search"
          className="w-full pl-8 pr-7 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-all"
          autoComplete="off"
        />
        {query && (
          <button
            onClick={clear}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition-colors"
          >
            <X size={13} />
          </button>
        )}
      </div>

      {open && query.trim() && (
        <div className="absolute left-0 right-0 top-full mt-1.5 z-50 bg-white border border-gray-200 rounded-xl shadow-xl overflow-hidden">
          {loading ? (
            <div className="px-4 py-5 flex items-center justify-center gap-2">
              <div className="w-3.5 h-3.5 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-gray-400">Searching…</span>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-5 text-center">
              <p className="text-xs text-gray-400">No results for &ldquo;{query}&rdquo;</p>
            </div>
          ) : (
            <div className="max-h-80 overflow-y-auto py-1">
              {categoryOrder.map((cat) => {
                const items = grouped[cat];
                if (!items?.length) return null;
                return (
                  <div key={cat}>
                    <p className="px-3 pt-2.5 pb-1 text-[10px] font-semibold text-gray-400 uppercase tracking-wider">
                      {cat}s
                    </p>
                    {items.map((result) => {
                      const globalIndex = results.indexOf(result);
                      const Icon = result.icon;
                      return (
                        <button
                          key={result.id}
                          onClick={() => navigate(result.href)}
                          onMouseEnter={() => setActiveIndex(globalIndex)}
                          className={`w-full flex items-center gap-3 px-3 py-2 text-left transition-colors ${
                            globalIndex === activeIndex
                              ? "bg-blue-50"
                              : "hover:bg-gray-50"
                          }`}
                        >
                          <div className={`w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0 ${
                            globalIndex === activeIndex ? "bg-blue-100" : "bg-gray-100"
                          }`}>
                            <Icon
                              size={13}
                              className={globalIndex === activeIndex ? "text-blue-600" : "text-gray-500"}
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className={`text-xs font-medium truncate ${
                              globalIndex === activeIndex ? "text-blue-700" : "text-gray-800"
                            }`}>
                              {result.label}
                            </p>
                            {result.description && (
                              <p className="text-[10px] text-gray-400 truncate mt-0.5">
                                {result.description}
                              </p>
                            )}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
              <p className="px-3 py-2 text-[10px] text-gray-300 border-t border-gray-100 mt-1">
                ↑↓ navigate · Enter to select · Esc to close
              </p>
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
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  function handleOpen() {
    setOpen((v) => !v);
    if (!open && unreadCount > 0) markAllRead();
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={handleOpen}
        className="text-gray-400 hover:text-gray-600 transition-colors relative"
      >
        <Bell size={size} />
        {unreadCount > 0 && (
          <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-0.5 bg-red-500 rounded-full flex items-center justify-center text-white text-[9px] font-bold leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute left-0 top-full mt-2 z-50 w-80 bg-white border border-gray-200 rounded-2xl shadow-2xl overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-100">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-gray-900">Notifications</span>
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full text-[10px] font-bold bg-red-500 text-white">
                  {unreadCount}
                </span>
              )}
            </div>
            {notifications.length > 0 && unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-blue-600 hover:text-blue-700 font-medium"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* Body */}
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center px-4 py-10 gap-2">
              <div className="w-10 h-10 rounded-full bg-gray-100 flex items-center justify-center">
                <Bell size={18} className="text-gray-300" />
              </div>
              <p className="text-xs text-gray-400 font-medium">No notifications yet</p>
              <p className="text-[11px] text-gray-300 text-center">New campaign activity will appear here</p>
            </div>
          ) : (
            <ul className="max-h-80 overflow-y-auto">
              {notifications.map((n) => (
                <li
                  key={n.id}
                  className={`flex items-start gap-3 px-4 py-3 border-b border-gray-50 last:border-b-0 transition-colors ${n.read ? "bg-white" : "bg-blue-50/60"}`}
                >
                  <div className={`mt-0.5 w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${n.read ? "bg-gray-100" : "bg-blue-100"}`}>
                    <CampaignIcon size={14} className={n.read ? "text-gray-400" : "text-blue-500"} />
                  </div>
                  <div className="flex-1 min-w-0 pt-0.5">
                    <p className={`text-xs leading-snug ${n.read ? "text-gray-600" : "text-gray-800 font-medium"}`}>{n.message}</p>
                    <p className="text-[10px] text-gray-400 mt-1">{n.time}</p>
                  </div>
                  {!n.read && (
                    <span className="mt-2 w-1.5 h-1.5 rounded-full bg-blue-500 shrink-0" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function SidebarContent() {
  const pathname = usePathname();

  return (
    <div className="flex flex-col h-full">
      {/* Logo / Header */}
      <div className="flex items-center justify-between px-4 py-4 border-b border-gray-100">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white text-xs font-bold">R</span>
          </div>
          <span className="font-semibold text-gray-900 text-sm leading-tight">
            Rooster Partners
          </span>
        </div>
        <NotificationBell size={18} />
      </div>

      {/* Global Search */}
      <div className="px-3 py-3 border-b border-gray-100">
        <GlobalSearch />
      </div>

      {/* Navigation */}
      <nav className="flex-1 px-2 py-2 overflow-y-auto">
        <ul className="space-y-0.5">
          {navItems.map((item) => {
            const isActive =
              pathname === item.href || pathname.startsWith(item.href + "/");
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-gray-900 text-white"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <Icon size={16} className={isActive ? "text-white" : "text-gray-500"} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>
    </div>
  );
}

function MobileTopBar() {
  const pathname = usePathname();
  const current = navItems.find(
    (n) => pathname === n.href || pathname.startsWith(n.href + "/")
  );
  const pageTitle = current?.label ?? "Dashboard";

  return (
    <div className="md:hidden fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
      <div className="flex items-center gap-2">
        <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
          <span className="text-white text-xs font-bold">R</span>
        </div>
        <span className="font-semibold text-gray-900 text-sm">{pageTitle}</span>
      </div>
      <div className="flex items-center gap-3">
        <NotificationBell size={20} />
        <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center">
          <span className="text-white text-xs font-bold">RP</span>
        </div>
      </div>
    </div>
  );
}

function MobileBottomNav() {
  const pathname = usePathname();

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-30 bg-white border-t border-gray-200 flex items-center">
      {navItems.map((item) => {
        const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
        const Icon = item.icon;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`flex-1 flex flex-col items-center justify-center py-2 gap-0.5 transition-colors ${
              isActive ? "text-blue-600" : "text-gray-400 hover:text-gray-600"
            }`}
          >
            <Icon size={20} />
            <span className="text-[10px] font-medium leading-none">{item.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}

export default function Sidebar() {
  return (
    <>
      {/* Mobile top bar */}
      <MobileTopBar />

      {/* Mobile bottom nav */}
      <MobileBottomNav />

      {/* Desktop sidebar */}
      <aside className="hidden md:flex w-60 min-w-[240px] bg-white border-r border-gray-200 flex-col h-screen">
        <SidebarContent />
      </aside>
    </>
  );
}
