"use client";

// Account dropdown for the global top bar. Profile is a stub and Sign out is disabled until
// Voizo has real user auth (Supabase Auth / shadow-account work); Settings + the theme toggle
// are live. Folding the theme toggle in here is what lets the top bar stay uncluttered.

import { useRef, useState, useEffect } from "react";
import Link from "next/link";
import { User, Settings, LogOut, Sun, Moon } from "lucide-react";
import { useTheme } from "@/lib/themeContext";

export default function AccountMenu() {
  const { isDark, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, []);

  const itemCls = "flex items-center gap-2.5 w-full px-3 py-2 text-xs text-left transition-colors";

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-label="Account menu"
        aria-expanded={open}
        className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-blue-700 flex items-center justify-center cursor-pointer ring-2 ring-transparent hover:ring-blue-500/30 transition"
      >
        <span className="text-white text-[10px] font-bold">V</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-52 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden py-1">
          <div className="px-3 py-2.5 border-b border-[var(--border)]">
            <p className="text-xs font-semibold text-[var(--text-1)]">Voizo Operator</p>
            <p className="text-[10px] text-[var(--text-3)] mt-0.5">Workspace</p>
          </div>

          <button type="button" disabled title="Profile — coming soon" className={`${itemCls} text-[var(--text-3)] cursor-not-allowed`}>
            <User size={13} /> Profile
          </button>

          <Link href="/settings" onClick={() => setOpen(false)} className={`${itemCls} text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]`}>
            <Settings size={13} /> Settings
          </Link>

          <button type="button" onClick={toggle} className={`${itemCls} justify-between text-[var(--text-2)] hover:bg-[var(--bg-hover)] hover:text-[var(--text-1)]`}>
            <span className="flex items-center gap-2.5">{isDark ? <Moon size={13} /> : <Sun size={13} />} Theme</span>
            <span className="text-[10px] text-[var(--text-3)] uppercase tracking-wide">{isDark ? "Dark" : "Light"}</span>
          </button>

          <div className="border-t border-[var(--border)] mt-1 pt-1">
            <button type="button" disabled title="Sign out — available once accounts ship" className={`${itemCls} text-[var(--text-3)] cursor-not-allowed`}>
              <LogOut size={13} /> Sign out
              <span className="ml-auto text-[9px] text-[var(--text-3)] border border-[var(--border)] rounded px-1 py-0.5">soon</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
