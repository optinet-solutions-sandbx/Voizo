"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Bell,
  Search,
  Megaphone,
  PhoneOff,
  BookOpen,
  Phone,
  Menu,
  X,
} from "lucide-react";

const navItems = [
  { label: "Campaigns", href: "/campaigns", icon: Megaphone },
  { label: "Do Not Call List", href: "/do-not-call", icon: PhoneOff },
  { label: "Knowledge Bases", href: "/knowledge-bases", icon: BookOpen },
  { label: "Phone numbers", href: "/phone-numbers", icon: Phone },
];

function SidebarContent({ onClose }: { onClose?: () => void }) {
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
        <div className="flex items-center gap-2">
          <button className="text-gray-400 hover:text-gray-600 transition-colors relative">
            <Bell size={18} />
            <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
          </button>
          {/* Close button — mobile only */}
          {onClose && (
            <button
              onClick={onClose}
              className="text-gray-400 hover:text-gray-600 transition-colors md:hidden"
            >
              <X size={18} />
            </button>
          )}
        </div>
      </div>

      {/* Global Search */}
      <div className="px-3 py-3 border-b border-gray-100">
        <div className="relative">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            placeholder="Global Search"
            className="w-full pl-8 pr-3 py-1.5 text-sm bg-gray-50 border border-gray-200 rounded-md text-gray-600 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
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
                  onClick={onClose}
                  className={`flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                    isActive
                      ? "bg-gray-900 text-white"
                      : "text-gray-600 hover:bg-gray-100 hover:text-gray-900"
                  }`}
                >
                  <Icon
                    size={16}
                    className={isActive ? "text-white" : "text-gray-500"}
                  />
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

export default function Sidebar() {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <>
      {/* ── Mobile top bar ── */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 flex items-center justify-between px-4 py-3 bg-white border-b border-gray-200">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 bg-blue-600 rounded-md flex items-center justify-center">
            <span className="text-white text-xs font-bold">R</span>
          </div>
          <span className="font-semibold text-gray-900 text-sm">Rooster Partners</span>
        </div>
        <button
          onClick={() => setMobileOpen(true)}
          className="text-gray-500 hover:text-gray-700 transition-colors"
        >
          <Menu size={22} />
        </button>
      </div>

      {/* ── Mobile overlay backdrop ── */}
      {mobileOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setMobileOpen(false)}
        />
      )}

      {/* ── Mobile slide-in drawer ── */}
      <aside
        className={`md:hidden fixed top-0 left-0 z-50 h-full w-64 bg-white shadow-xl transform transition-transform duration-300 ${
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <SidebarContent onClose={() => setMobileOpen(false)} />
      </aside>

      {/* ── Desktop sidebar ── */}
      <aside className="hidden md:flex w-60 min-w-[240px] bg-white border-r border-gray-200 flex-col h-screen">
        <SidebarContent />
      </aside>
    </>
  );
}
