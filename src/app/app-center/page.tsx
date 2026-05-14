"use client";

import { useState } from "react";
import { Search, Plus, MoreHorizontal, Phone, ExternalLink } from "lucide-react";

const CATEGORIES = [
  { label: "Connected", count: 1 },
  { label: "Telephony & Communication" },
  { label: "Sales & CRM" },
  { label: "Marketing Automation" },
  { label: "Productivity & Collaboration" },
  { label: "E Commerce & Payments" },
  { label: "Helpdesk & Customer Support" },
  { label: "Scheduling & Calendar" },
  { label: "HR & Recruitment" },
  { label: "Analytics & Reporting" },
  { label: "AI" },
  { label: "Social Media" },
  { label: "Email" },
  { label: "Workflow Automation" },
  { label: "Core Tools" },
  { label: "Others" },
];

export default function AppCenterPage() {
  const [activeCategory, setActiveCategory] = useState("Connected");
  const [searchQuery, setSearchQuery] = useState("");

  const filtered = searchQuery.trim()
    ? CATEGORIES.filter((c) => c.label.toLowerCase().includes(searchQuery.toLowerCase()))
    : CATEGORIES;

  return (
    <div className="flex flex-col h-full min-h-0 w-full">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5 pb-4 flex-shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-[var(--text-1)]">App Center</h1>
            <a
              href="#"
              className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 border border-[var(--border)] rounded-full text-xs sm:text-sm font-medium text-[var(--text-2)] hover:bg-[var(--bg-hover)] transition-colors"
            >
              Read Help Doc
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>
      <div className="border-b border-[var(--border)] mx-4 sm:mx-6 flex-shrink-0" />

      {/* ── Mobile: horizontal category pills ── */}
      <div className="md:hidden flex-shrink-0">
        <div className="px-4 pt-3 pb-1">
          <div className="relative mb-3">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
            <input
              type="text"
              placeholder="Search Integrations"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-lg text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
        <div className="overflow-x-auto px-4 pb-3">
          <div className="flex items-center gap-2 min-w-max">
            {filtered.map((cat) => {
              const isActive = activeCategory === cat.label;
              return (
                <button
                  key={cat.label}
                  onClick={() => setActiveCategory(cat.label)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-colors ${
                    isActive
                      ? "bg-blue-600 text-white"
                      : "bg-[var(--bg-elevated)] text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {cat.label}
                  {cat.count !== undefined && (
                    <span className={`text-xs ${isActive ? "text-blue-200" : "text-[var(--text-3)]"}`}>
                      {cat.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-b border-[var(--border)]" />
        {/* Mobile content */}
        <div className="p-4">
          {activeCategory === "Connected" ? <ConnectedView /> : <EmptyCategoryView category={activeCategory} />}
        </div>
      </div>

      {/* ── Desktop: sidebar + content ── */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar */}
        <div className="w-64 min-w-[220px] border-r border-[var(--border)] flex flex-col py-4 overflow-y-auto flex-shrink-0">
          <div className="px-3 mb-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]" />
              <input
                type="text"
                placeholder="Search Integrations"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-[var(--bg-card)] border border-[var(--border)] rounded-md text-[var(--text-1)] placeholder-[var(--text-3)] focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
            </div>
          </div>
          <ul>
            {filtered.map((cat) => {
              const isActive = activeCategory === cat.label;
              return (
                <li key={cat.label}>
                  <button
                    onClick={() => setActiveCategory(cat.label)}
                    className={`w-full flex items-center justify-between px-4 py-2 text-sm transition-colors ${
                      isActive
                        ? "bg-[var(--bg-elevated)] font-semibold text-[var(--text-1)]"
                        : "text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
                    }`}
                  >
                    <span>{cat.label}</span>
                    {cat.count !== undefined && (
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${isActive ? "bg-[var(--border)] text-[var(--text-1)]" : "bg-[var(--bg-elevated)] text-[var(--text-2)]"}`}>
                        {cat.count}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
        {/* Right content */}
        <div className="flex-1 overflow-y-auto p-6">
          {activeCategory === "Connected" ? <ConnectedView /> : <EmptyCategoryView category={activeCategory} />}
        </div>
      </div>
    </div>
  );
}

function ConnectedView() {
  return (
    <div>
      <p className="text-xs font-semibold text-[var(--text-3)] uppercase tracking-widest mb-3">Connected</p>
      <div className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl overflow-hidden max-w-2xl">
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-[var(--border)]">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-emerald-500/15 rounded-lg flex items-center justify-center flex-shrink-0">
              <Phone size={16} className="text-emerald-400" />
            </div>
            <span className="text-sm font-semibold text-[var(--text-1)]">SIP Integration</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 bg-emerald-500/15 border border-emerald-500/25 rounded-full text-xs font-medium text-emerald-400">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
              Connected
            </span>
            <button className="w-7 h-7 rounded-full border border-[var(--border)] flex items-center justify-center text-[var(--text-2)] hover:bg-[var(--bg-hover)] transition-colors">
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5">
          <span className="text-sm text-[var(--text-2)]">N1 Greece Limited (RoosterPartners)</span>
          <button className="text-[var(--text-3)] hover:text-[var(--text-2)] transition-colors p-1">
            <MoreHorizontal size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}

function EmptyCategoryView({ category }: { category: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-48 sm:h-64 text-center">
      <div className="w-12 h-12 bg-[var(--bg-elevated)] rounded-xl flex items-center justify-center mb-3">
        <span className="text-[var(--text-3)] text-lg font-bold">{category[0]}</span>
      </div>
      <p className="text-sm font-medium text-[var(--text-2)]">{category}</p>
      <p className="text-xs text-[var(--text-3)] mt-1">No integrations connected yet.</p>
    </div>
  );
}
