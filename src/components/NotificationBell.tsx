"use client";

// Shared notifications bell + dropdown. Consolidated 2026-06-16 (hybrid-nav) from the two
// near-identical copies that lived in Header.tsx (desktop) and Sidebar.tsx (mobile).
// `align` controls which edge the dropdown opens from; `size` sizes the bell glyph.

import { useRef, useState, useEffect } from "react";
import { Bell, PhoneOff, BookOpen, Megaphone } from "lucide-react";
import { useNotifications } from "@/lib/notificationsContext";
import { useReducedMotion } from "motion/react";
import { BellIcon } from "@/components/icons/animated/bell";
import type { AnimatedIconHandle } from "@/components/icons/animated/types";

export default function NotificationBell({ size = 18, align = "right" }: { size?: number; align?: "left" | "right" }) {
  const { notifications, unreadCount, markAllRead } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const bellRef = useRef<AnimatedIconHandle>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
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
        onMouseEnter={() => { if (!reduce) bellRef.current?.startAnimation(); }}
        onMouseLeave={() => bellRef.current?.stopAnimation()}
        className="relative p-2 rounded-xl text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-elevated)] transition-colors"
        aria-label="Notifications"
      >
        <BellIcon ref={bellRef} size={size} />
        {unreadCount > 0 && (
          <span className="absolute top-1 right-1 min-w-[15px] h-[15px] px-0.5 bg-blue-500 rounded-full flex items-center justify-center text-white text-[8px] font-bold leading-none">
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className={`absolute ${align === "right" ? "right-0" : "left-0"} top-full mt-2 z-50 w-80 bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl shadow-2xl overflow-hidden`}>
          <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-[var(--text-1)]">Notifications</span>
              {unreadCount > 0 && (
                <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full text-[9px] font-bold bg-blue-500 text-white">
                  {unreadCount}
                </span>
              )}
            </div>
            {notifications.length > 0 && unreadCount > 0 && (
              <button onClick={markAllRead} className="text-xs text-blue-400 hover:text-blue-300 font-medium transition-colors">
                Mark all read
              </button>
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
                const Icon = isDnc ? PhoneOff : isKb ? BookOpen : Megaphone;
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
