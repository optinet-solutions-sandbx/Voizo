"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import {
  PhoneOff, BookOpen, LayoutDashboard, Sun, Moon, Globe2, Check,
  Activity, Users, PanelLeftClose, PanelLeftOpen, ClipboardCheck, Megaphone, Workflow, FlaskConical,
} from "lucide-react";
import { useTheme } from "@/lib/themeContext";
import { ALL_BRANDS, setBrandScope, useBrandScope } from "@/lib/brandScope";
import { BRAND_GLYPH_BG, BRAND_WORKSPACES, brandGlyph, brandLabel } from "@/lib/campaignDisplay";
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
      { label: "QA Prompt Testing", href: "/qa-prompt-testing", icon: FlaskConical, animatedIcon: ClipboardCheckIcon, ...NEUTRAL },
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

// The stored preference is now COLLAPSED (Jasiel 2026-09-03, the Gemini toggle): true = icon rail
// that peeks open on hover; false = expanded. New key, so the old lock value cannot invert it.
const SIDEBAR_LOCK_KEY = "voizo-sidebar-collapsed";
const SIDEBAR_LOCK_EVENT = "voizo-sidebar-collapse-change";

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

// "All brands" is a scope reset, not a brand, so it gets the neutral — which is also the fallback
// for any workspace with no colour of its own. The per-brand hues live beside the names in
// campaignDisplay.ts (BRAND_GLYPH_BG), one catalog instead of two that can drift apart.
const NEUTRAL_GLYPH_BG = "linear-gradient(145deg,#4a5160,#353b47)";

// Brand switcher (dashboard mockup, ported 2026-09-03): the page-level brand scope, at the top of
// the sidebar where the mockup put it. "All brands" is offered first but is not the default.
//
// The menu is an ATTACHED PANEL (2026-09-17, ten brands): it drops out of the header at the
// sidebar's full width and sits flush under the header's own bottom border, so it reads as the
// header opening rather than a card floating over the nav. The header is the positioned
// ancestor (see SidebarContent) — this root is deliberately not `relative`.
// ponytail: hand-rolled like StyledSelect; promote both to radix-ui DropdownMenu if a third menu appears.
function BrandSwitcher({ collapsed }: { collapsed: boolean }) {
  const brand = useBrandScope();
  const [open, setOpen] = useState(false);
  const reduce = useReducedMotion();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const label = brand === ALL_BRANDS ? "All brands" : brandLabel(brand);
  const brands = BRAND_WORKSPACES.map((ws) => [ws, brandLabel(ws), brandGlyph(brandLabel(ws))] as const);
  // A collapsed rail is 64px wide with no room for the panel. DERIVED, not synced in an effect:
  // setState inside an effect is a react-hooks/set-state-in-effect error and costs a second render.
  const menuOpen = open && !collapsed;

  // Opening moves focus to the current choice so the arrow keys start from it.
  useEffect(() => {
    if (!menuOpen) return;
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    (rows.find((r) => r.getAttribute("aria-checked") === "true") ?? rows[0])?.focus();
  }, [menuOpen]);

  const close = () => { setOpen(false); triggerRef.current?.focus(); };
  const choose = (key: string) => { setBrandScope(key); close(); };

  // Escape closes; ↑/↓/Home/End move between rows and wrap. Focus on the trigger counts as
  // "before the first row", so ↓ enters at the top and ↑ at the bottom.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Closed: ↑/↓ open the menu, the standard menu-button behaviour.
    if (!menuOpen) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
      return;
    }
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    const rows = Array.from(panelRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitemradio]") ?? []);
    if (rows.length === 0) return;
    const i = rows.indexOf(document.activeElement as HTMLButtonElement);
    let next: number;
    switch (e.key) {
      case "ArrowDown": next = i + 1; break;
      case "ArrowUp": next = i < 0 ? rows.length - 1 : i - 1; break;
      case "Home": next = 0; break;
      case "End": next = rows.length - 1; break;
      default: return;
    }
    e.preventDefault();
    rows[(next + rows.length) % rows.length].focus();
  };

  const row = (key: string, name: string, glyph: string) => {
    const selected = key === brand;
    return (
      <button
        key={key || "all"}
        type="button"
        role="menuitemradio"
        aria-checked={selected}
        onClick={() => choose(key)}
        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[13px] text-left outline-none transition-colors hover:bg-[var(--bg-hover)] focus-visible:bg-[var(--bg-hover)] ${
          selected ? "text-[var(--text-1)]" : "text-[var(--text-2)] hover:text-[var(--text-1)] focus-visible:text-[var(--text-1)]"
        }`}
      >
        <span className="w-6 h-6 rounded-md flex items-center justify-center text-white text-[10px] font-bold shrink-0" style={{ background: BRAND_GLYPH_BG[key] ?? NEUTRAL_GLYPH_BG }}>{glyph}</span>
        <span className="flex-1 truncate">{name}</span>
        {selected && <Check size={13} strokeWidth={2.5} aria-hidden className="shrink-0 text-primary" />}
      </button>
    );
  };

  return (
    // The VOIZO block IS the switcher (Jasiel 2026-09-03): the brand sits where "DIALER" was, and
    // the block opens the brand menu. The logo mark stays the V for now.
    <div
      className="min-w-0"
      onKeyDown={onKeyDown}
      // Tab out of the panel and the menu would otherwise stay open with its full-screen click
      // catcher swallowing the next click anywhere on the page.
      onBlurCapture={(e) => { if (open && !e.currentTarget.contains(e.relatedTarget)) setOpen(false); }}
    >
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        aria-label={`Brand: ${label}`}
        title={collapsed ? label : undefined}
        onClick={() => setOpen((o) => !o)}
        className={`group flex items-center rounded-lg transition-colors ${collapsed ? "flex-col gap-1" : "gap-3 pr-1 text-left"}`}
      >
        <div
          className="w-11 h-11 rounded-xl flex items-center justify-center flex-shrink-0"
          style={{ background: "linear-gradient(145deg,#4d90f0,#3a6fd0)", boxShadow: "0 2px 10px rgba(77,144,240,.35)" }}
        >
          <span className="text-white text-base font-bold">V</span>
        </div>
        {!collapsed && (
          <>
            <div className="flex flex-col leading-none min-w-0">
              <span className="font-bold text-[var(--text-1)] text-sm">VOIZO</span>
              <span className="text-[10px] tracking-wide text-[var(--text-3)] mt-0.5 truncate group-hover:text-[var(--text-2)] transition-colors">{label}</span>
            </div>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className={`shrink-0 text-[var(--text-3)] transition-transform ${menuOpen ? "rotate-180" : ""}`}><path d="m6 9 6 6 6-6" /></svg>
          </>
        )}
      </button>
      {menuOpen && (
        <>
          <button type="button" tabIndex={-1} aria-label="Close brand menu" onClick={close} className="fixed inset-0 z-40 cursor-default" />
          <div
            ref={panelRef}
            role="menu"
            aria-label="Brand"
            // max-h is a safety net, not the design: at a normal window height the whole list
            // fits and nothing scrolls. It only engages on a short/zoomed viewport, where the
            // aside's own overflow-hidden would otherwise cut the last brands off unreachably.
            className={`absolute left-0 right-0 top-full mt-px z-50 max-h-[calc(100vh-5rem)] overflow-y-auto rounded-b-xl border-b border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 p-1 ${
              reduce ? "" : "animate-in fade-in slide-in-from-top-1 duration-150"
            }`}
          >
            {/* Every brand is listed, no scrolling (Jasiel 2026-09-17: rows sliding under a pinned
                "All brands" read as a defect). Eleven rows are ~410px.
                ponytail: fixed list; re-add max-h + overflow-y-auto if the catalog passes ~14. */}
            {row(ALL_BRANDS, "All brands", "AB")}
            {/* "All brands" is a scope reset, not a brand — the rule keeps it apart from the list. */}
            <hr className="my-1 h-px border-0 bg-[var(--border)]" />
            {brands.map(([ws, name, glyph]) => row(ws, name, glyph))}
          </div>
        </>
      )}
    </div>
  );
}

function SidebarContent({ collapsed, locked, setLocked }: { collapsed: boolean; locked: boolean; setLocked: (locked: boolean) => void }) {
  const pathname = usePathname();
  return (
    <div className="flex flex-col h-full">
      {/* `relative`: the brand menu is positioned against this header so it spans the sidebar. */}
      <div className={`relative flex items-center px-3 py-3 border-b border-[var(--border)] ${collapsed ? "justify-center flex-col gap-1" : "justify-between gap-2"}`}>
        <BrandSwitcher collapsed={collapsed} />
        {/* The panel toggle (Gemini's mechanism): collapse to an icon rail, or pin it open. A
            collapsed rail peeks open on hover, and this button shows in the peek to pin it back. */}
        {collapsed ? null : (
          <button
            type="button"
            onClick={() => setLocked(!locked)}
            aria-pressed={locked}
            aria-label={locked ? "Pin the sidebar open" : "Collapse the sidebar"}
            title={locked ? "Pin the sidebar open" : "Collapse the sidebar to icons"}
            className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-3)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] transition-all"
          >
            {locked ? <PanelLeftOpen size={15} /> : <PanelLeftClose size={15} />}
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
  const locked = useSyncExternalStore(subscribeLock, getLockSnapshot, getLockServerSnapshot);
  const [hovered, setHovered] = useState(false);
  // KEYBOARD focus inside the rail peeks it open the same way hover does — otherwise the brand
  // menu (and every label) is unreachable without a mouse while the rail is collapsed.
  // :focus-visible is the whole point: a plain mouse click also focuses the button it hits, and
  // counting that as "peek" left the rail stuck open after clicking its own collapse toggle.
  const [focused, setFocused] = useState(false);
  // `locked` now reads "collapsed by choice" (the toggle in the header). Expanded by default on
  // every page; a collapsed rail peeks open while hovered or focused.
  const collapsed = locked && !hovered && !focused;

  return (
    <>
      <MobileTopBar />
      <MobileBottomNav />
      <aside
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocusCapture={(e) => { if (e.target instanceof HTMLElement && e.target.matches(":focus-visible")) setFocused(true); }}
        onBlurCapture={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setFocused(false); }}
        className="hidden md:flex bg-[var(--bg-sidebar)] border-r border-[var(--border)] flex-col h-screen overflow-hidden transition-[width] duration-300 ease-[cubic-bezier(.2,.7,.2,1)]"
        style={{ width: collapsed ? 64 : 200 }}
      >
        <SidebarContent collapsed={collapsed} locked={locked} setLocked={writeLock} />
      </aside>
    </>
  );
}
