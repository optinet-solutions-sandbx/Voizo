// Ported verbatim from page-classic.tsx:37-109 so wizard fields look
// identical to the existing form's dropdowns. Supports grouped options
// (e.g. "Americas" / "Europe" / "Asia / Pacific" / "Other" for timezones),
// outside-click close, optional leading icon, optional placeholder.

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  group?: string;
}

interface Props {
  icon?: ReactNode;
  options: DropdownOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}

export default function StyledSelect({ icon, options, value, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const groups = options.reduce<Record<string, DropdownOption[]>>((acc, o) => {
    const g = o.group || "";
    (acc[g] ??= []).push(o);
    return acc;
  }, {});
  const groupKeys = Object.keys(groups);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className={`w-full flex items-center gap-2.5 ${icon ? "pl-3.5" : "pl-4"} pr-10 py-3 rounded-xl bg-[var(--bg-app)] border text-sm text-left cursor-pointer transition-all ${
          open
            ? "border-blue-500 ring-1 ring-blue-500"
            : "border-[var(--border)] hover:border-blue-500/40"
        }`}
      >
        {icon && <span className="text-[var(--text-3)] shrink-0">{icon}</span>}
        <span className={selected ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}>
          {selected?.label || placeholder || "Select…"}
        </span>
      </button>
      <div className="pointer-events-none absolute right-3.5 top-1/2 -translate-y-1/2 text-[var(--text-3)]">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {open && (
        <div className="absolute z-50 mt-1.5 w-full max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
          {groupKeys.map((g) => (
            <div key={g}>
              {g && (
                <div className="px-3.5 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-3)]">
                  {g}
                </div>
              )}
              {groups[g].map((o) => (
                <button
                  key={o.value}
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`w-full text-left px-3.5 py-2.5 text-sm transition-colors ${
                    o.value === value
                      ? "bg-blue-600/20 text-blue-400"
                      : "text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
