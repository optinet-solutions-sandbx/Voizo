"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useRef, useState, useSyncExternalStore } from "react";
import {
  PhoneOff, BookOpen, LayoutDashboard, Sun, Moon, Globe2,
  Activity, Users, Lock, LockOpen, ClipboardCheck, Megaphone, Workflow,
} from "lucide-react";
import { useTheme } from "@/lib/themeContext";
import NotificationBell from "@/components/NotificationBell";
// Animated sidebar nav icons (lucide-animated.com, motion-powered). These run
// only on the desktop nav; the mobile bottom nav reuses the same animated icons.
import { useReducedMotion } from "motion/react";
import { LayoutGridIcon } from "@/components/icons/animated/layout-grid";
import { ActivityIcon } from "@/components/icons/animated/activity";
import { EarthIcon } from "@/components/icons/animated/earth";
import { SendIcon } from "@/components/icons/animated/send";
import { UsersIcon } from "@/components/icons/animated/users";
import { PhoneMissedIcon } from "@/components/icons/animated/phone-missed";
import { BookTextIcon } from "@/components/icons/animated/book-text";
import { ClipboardCheckIcon } from "@/components/icons/animated/clipboard-check";
import { WorkflowIcon } from "@/components/icons/animated/workflow";
import type { AnimatedIcon, AnimatedIconHandle } from "@/components/icons/animated/types";

// Hybrid nav (2026-06-16): the sidebar is now NAV-ONLY (search + notifications moved to the
// global top bar). Destinations are grouped into labeled sections; group headers show when the
// sidebar is expanded and collapse to icon clusters when it auto-collapses.
//
// P2 Option C (2026-05-22): semantic-accents-only. Inactive chips neutralize except Do Not Call,
// which keeps the red warning hue. Active state is blue (desktop) / blue-or-red-for-DNC (mobile).
interface NavItem {
  label: string;
  href: string;
  icon: typeof Activity;
  animatedIcon: AnimatedIcon;
  color: string;
  bg: string;
}

const NEUTRAL = { color: "text-[var(--text-2)]", bg: "bg-[var(--bg-elevated)]" } as const;

const navSections: { label: string; items: NavItem[] }[] = [
  {
    label: "Operations",
    items: [
      { label: "Dashboard",     href: "/dashboard", icon: LayoutDashboard, animatedIcon: LayoutGridIcon, ...NEUTRAL },
      { label: "Live Activity", href: "/activity",  icon: Activity,        animatedIcon: ActivityIcon,    ...NEUTRAL },
      { label: "Workers",       href: "/workers",   icon: Globe2,          animatedIcon: EarthIcon,       ...NEUTRAL },
      { label: "Campaigns",     href: "/campaigns", icon: Megaphone,       animatedIcon: SendIcon,        ...NEUTRAL },
    ],
  },
  {
    label: "Data",
    items: [
      { label: "Script Builder", href: "/script-builder", icon: Workflow, animatedIcon: WorkflowIcon,   ...NEUTRAL },
      { label: "Reviews",  href: "/reviews",  icon: ClipboardCheck, animatedIcon: ClipboardCheckIcon, ...NEUTRAL },
      { label: "Audience", href: "/audience", icon: Users,          animatedIcon: UsersIcon,          ...NEUTRAL },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Do Not Call", href: "/do-not-call",     icon: PhoneOff, animatedIcon: PhoneMissedIcon, color: "text-red-400", bg: "bg-red-500/10" },
      { label: "Knowledge",   href: "/knowledge-bases", icon: BookOpen, animatedIcon: BookTextIcon,    ...NEUTRAL },
    ],
  },
];

const navItems: NavItem[] = navSections.flatMap((s) => s.items);

const SIDEBAR_LOCK_KEY = "voizo-sidebar-locked";
const SIDEBAR_LOCK_EVENT = "voizo-sidebar-lock-change";

// External-store accessors for the persisted sidebar lock. Read via useSyncExternalStore so the
// server + first client paint agree (collapsed default), then the client localStorage value takes
// over — no hydration mismatch, no set-state-in-effect. Lock also syncs across tabs.
function subscribeLock(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(SIDEBAR_LOCK_EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(SIDEBAR_LOCK_EVENT, onChange);
  };
}
function getLockSnapshot(): boolean {
  try { return localStorage.getItem(SIDEBAR_LOCK_KEY) === "true"; } catch { return false; }
}
function getLockServerSnapshot(): boolean {
  return false; // default AUTO (collapsed) — matches the server render
}
function writeLock(value: boolean): void {
  try { localStorage.setItem(SIDEBAR_LOCK_KEY, String(value)); } catch { /* ignore */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(SIDEBAR_LOCK_EVENT));
}

// A single desktop nav row. Owns a ref to its animated icon and plays the animation while the
// whole row is hovered (not just the glyph). Honors reduced-motion.
function NavRow({ item, isActive, collapsed }: { item: NavItem; isActive: boolean; collapsed: boolean }) {
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
        className={`relative flex items-center ${collapsed ? "justify-center px-1.5" : "gap-2.5 px-2.5"} py-1.5 rounded-lg text-[13px] font-medium transition-all ${
          isActive
            ? "bg-[var(--bg-hover)] text-[var(--text-1)]"
            : "text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]"
        }`}
      >
        {/* Active marker (pattern brief frame): 3px primary bar, not a solid pill. */}
        {isActive && <span aria-hidden className="absolute left-0 top-[7px] bottom-[7px] w-[3px] rounded-[3px] bg-primary" />}
        <div className={`w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0 ${isActive ? "bg-primary/15" : item.bg}`}>
          <Icon ref={iconRef} size={13} className={isActive ? "text-primary" : item.color} />
        </div>
        {!collapsed && item.label}
      </Link>
    </li>
  );
}

function SidebarContent({ collapsed, locked, setLocked }: { collapsed: boolean; locked: boolean; setLocked: (locked: boolean) => void }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-full">
      <div className={`flex items-center px-3 py-3 border-b border-[var(--border)] ${collapsed ? "justify-center flex-col gap-1" : "justify-between gap-2"}`}>
        <Link href="/dashboard" className={`flex items-center group ${collapsed ? "flex-col gap-1" : "gap-3"}`}>
          <div
            className="w-11 h-11 rounded-xl flex items-center justify-center transition-all flex-shrink-0"
            style={{ background: "linear-gradient(145deg,#4d90f0,#3a6fd0)", boxShadow: "0 2px 10px rgba(77,144,240,.35)" }}
          >
            <span className="text-white text-base font-bold">V</span>
          </div>
          {!collapsed && (
            <div className="flex flex-col leading-none">
              <span className="font-bold text-[var(--text-1)] text-sm">VOIZO</span>
              <span className="text-[9px] tracking-wider uppercase text-[var(--text-3)] mt-0.5">DIALER</span>
            </div>
          )}
        </Link>
        {collapsed ? (
          <span className="text-[9px] tracking-wider uppercase text-[var(--text-3)] leading-none">DIALER</span>
        ) : (
          <button
            type="button"
            onClick={() => setLocked(!locked)}
            aria-pressed={locked}
            title={locked ? "Unlock (auto-collapse on mouse-leave)" : "Lock sidebar open"}
            className={`shrink-0 w-7 h-7 rounded-lg flex items-center justify-center transition-all ${
              locked
                ? "bg-[var(--bg-card)] border border-[var(--border-2)] text-[var(--text-1)]"
                : "text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
            }`}
          >
            {locked ? <Lock size={13} /> : <LockOpen size={13} />}
          </button>
        )}
      </div>

      <nav className="flex-1 px-2 py-2 overflow-y-auto">
        {navSections.map((section) => (
          <div key={section.label} className="mb-2 last:mb-0">
            {!collapsed && (
              <p className="px-2 mb-1 text-[10px] font-semibold text-[var(--text-3)] uppercase tracking-widest">{section.label}</p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => {
                const isActive = pathname === item.href || pathname.startsWith(item.href + "/");
                return <NavRow key={item.href} item={item} isActive={isActive} collapsed={collapsed} />;
              })}
            </ul>
          </div>
        ))}
      </nav>
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
        <div className="w-7 h-7 bg-primary rounded-lg flex items-center justify-center">
          <span className="text-white text-xs font-bold">V</span>
        </div>
        <span className="font-semibold text-[var(--text-1)] text-sm">{pageTitle}</span>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={toggle} className="p-1.5 rounded-lg text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors">
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        <NotificationBell size={20} align="right" />
        <div className="w-7 h-7 bg-gradient-to-br from-primary to-primary rounded-full flex items-center justify-center">
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
        const activeColor = item.href === "/do-not-call" ? "text-red-400" : "text-primary";
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
  // Persisted lock read SSR-safely via useSyncExternalStore (server + first client paint render
  // the collapsed default → no hydration mismatch; React then swaps in the localStorage value).
  const pathname = usePathname();
  const locked = useSyncExternalStore(subscribeLock, getLockSnapshot, getLockServerSnapshot);
  const [hovered, setHovered] = useState(false);
  // Dashboard is the home view — always expanded. Other pages keep the compact auto-collapse rail.
  const onDashboard = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  const collapsed = !locked && !hovered && !onDashboard;

  return (
    <>
      <MobileTopBar />
      <MobileBottomNav />
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className="hidden md:flex bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex-col h-screen overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]"
        style={{ width: collapsed ? 64 : 200 }}
      >
        <SidebarContent collapsed={collapsed} locked={locked} setLocked={writeLock} />
      </aside>
    </>
  );
}
