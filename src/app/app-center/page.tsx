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
    <div className="flex flex-col h-full min-h-0 max-w-[1500px]">
      {/* Header */}
      <div className="px-4 sm:px-6 pt-5 pb-4 flex-shrink-0">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-xl sm:text-2xl font-bold text-gray-900">App Center</h1>
            <a
              href="#"
              className="flex items-center gap-1.5 px-3 sm:px-4 py-1.5 border border-gray-300 rounded-full text-xs sm:text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Read Help Doc
              <ExternalLink size={12} />
            </a>
          </div>
        </div>
      </div>
      <div className="border-b border-gray-200 mx-4 sm:mx-6 flex-shrink-0" />

      {/* ── Mobile: horizontal category pills ── */}
      <div className="md:hidden flex-shrink-0">
        <div className="px-4 pt-3 pb-1">
          <div className="relative mb-3">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search Integrations"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-8 pr-3 py-2 text-sm bg-white border border-gray-200 rounded-lg text-gray-600 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                      ? "bg-gray-900 text-white"
                      : "bg-gray-100 text-gray-600 hover:bg-gray-200"
                  }`}
                >
                  {cat.label}
                  {cat.count !== undefined && (
                    <span className={`text-xs ${isActive ? "text-gray-300" : "text-gray-400"}`}>
                      {cat.count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        <div className="border-b border-gray-100" />
        {/* Mobile content */}
        <div className="p-4">
          {activeCategory === "Connected" ? <ConnectedView /> : <EmptyCategoryView category={activeCategory} />}
        </div>
      </div>

      {/* ── Desktop: sidebar + content ── */}
      <div className="hidden md:flex flex-1 min-h-0 overflow-hidden">
        {/* Left sidebar */}
        <div className="w-64 min-w-[220px] border-r border-gray-100 flex flex-col py-4 overflow-y-auto flex-shrink-0">
          <div className="px-3 mb-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                type="text"
                placeholder="Search Integrations"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-8 pr-3 py-1.5 text-sm bg-white border border-gray-200 rounded-md text-gray-600 placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
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
                        ? "bg-gray-100 font-semibold text-gray-900"
                        : "text-gray-500 hover:text-gray-800 hover:bg-gray-50"
                    }`}
                  >
                    <span>{cat.label}</span>
                    {cat.count !== undefined && (
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${isActive ? "bg-gray-200 text-gray-700" : "bg-gray-100 text-gray-500"}`}>
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
      <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">Connected</p>
      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden max-w-2xl">
        <div className="flex items-center justify-between px-4 sm:px-5 py-4 border-b border-gray-100">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 bg-green-50 rounded-lg flex items-center justify-center flex-shrink-0">
              <Phone size={16} className="text-green-600" />
            </div>
            <span className="text-sm font-semibold text-gray-900">SIP Integration</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 px-2.5 sm:px-3 py-1 bg-green-50 border border-green-200 rounded-full text-xs font-medium text-green-700">
              <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
              Connected
            </span>
            <button className="w-7 h-7 rounded-full border border-gray-200 flex items-center justify-center text-gray-500 hover:bg-gray-50 transition-colors">
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 sm:px-5 py-3.5">
          <span className="text-sm text-gray-700">N1 Greece Limited (RoosterPartners)</span>
          <button className="text-gray-400 hover:text-gray-600 transition-colors p-1">
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
      <div className="w-12 h-12 bg-gray-100 rounded-xl flex items-center justify-center mb-3">
        <span className="text-gray-400 text-lg font-bold">{category[0]}</span>
      </div>
      <p className="text-sm font-medium text-gray-700">{category}</p>
      <p className="text-xs text-gray-400 mt-1">No integrations connected yet.</p>
    </div>
  );
}
