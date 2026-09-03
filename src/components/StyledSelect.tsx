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
  /** When true, the trigger is unclickable + visually muted. Used by the
   *  country-aware TZ guardrail when only one option is valid. */
  disabled?: boolean;
  /** "sm" = compact (filter rows, matches DatePickerField); "md" (default) = form-field size. */
  size?: "sm" | "md";
  /** Muted axis label inside the trigger ("Family:"), so a toolbar of selects reads "Axis: value"
   *  in one vocabulary (dashboard, 2026-09-03). */
  prefix?: string;
  /** Trigger surface. "app" (default) is the form-field convention; "elevated" sits inside cards
   *  without the high-contrast well (dashboard filter bars). The compact size is always elevated. */
  surface?: "app" | "elevated";
}

export default function StyledSelect({ icon, options, value, onChange, placeholder, disabled, size = "md", prefix, surface = "app" }: Props) {
  const sm = size === "sm";
  const elevated = sm || surface === "elevated";
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
        onClick={() => !disabled && setOpen(!open)}
        disabled={disabled}
        className={`w-full flex items-center ${sm ? "gap-2 pr-8 py-2 rounded-lg text-sm" : "gap-2.5 pr-10 py-3 rounded-xl text-sm"} ${icon ? (sm ? "pl-3" : "pl-3.5") : (sm ? "pl-3" : "pl-4")} ${elevated ? "bg-[var(--bg-elevated)]" : "bg-[var(--bg-app)]"} border text-left transition-all ${
          disabled
            ? "border-[var(--border)] opacity-60 cursor-not-allowed"
            : open
              ? "border-primary ring-1 ring-primary cursor-pointer"
              : "border-[var(--border)] hover:border-primary/40 cursor-pointer"
        }`}
      >
        {icon && <span className="text-[var(--text-3)] shrink-0">{icon}</span>}
        {prefix && <span className="text-[var(--text-3)] shrink-0">{prefix}</span>}
        {/* The closed trigger is a fixed-width control, so a long value still ellipses
            here — title exposes it on hover. The OPEN panel below no longer truncates. */}
        <span
          title={selected?.label}
          className={`min-w-0 truncate ${selected ? "text-[var(--text-1)]" : "text-[var(--text-3)]"}`}
        >
          {selected?.label || placeholder || "Select…"}
        </span>
      </button>
      <div className={`pointer-events-none absolute ${sm ? "right-2.5" : "right-3.5"} top-1/2 -translate-y-1/2 text-[var(--text-3)]`}>
        <svg width={sm ? 12 : 14} height={sm ? 12 : 14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={`transition-transform ${open ? "rotate-180" : ""}`}>
          <path d="m6 9 6 6 6-6" />
        </svg>
      </div>
      {open && (
        // The panel was `w-full` — locked to the trigger's width — so any option longer
        // than the closed button was cut ("FortunePla…", "Lucky7eve…"; Val 2026-08-25).
        // Size it to its content instead: never narrower than the trigger, never wider
        // than the viewport allows. It is absolutely positioned, so growing it cannot
        // reflow the page behind it.
        // `w-max` measured 300px for 67px of text (2026-09-03: the percentage-width rows inside a
        // max-content box resolve against the cap); shrink-to-fit (auto) gives the trigger's width
        // or the longest option, whichever is wider.
        <div className="absolute z-50 mt-1.5 min-w-full max-w-[min(90vw,28rem)] max-h-64 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-card)] shadow-xl shadow-black/30 py-1">
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
                  className={`w-full text-left ${sm ? "px-3 py-2 text-sm" : "px-3.5 py-2.5 text-sm"} transition-colors ${
                    o.value === value
                      ? "bg-primary/20 text-primary"
                      : "text-[var(--text-1)] hover:bg-[var(--bg-hover)]"
                  }`}
                >
                  <span className="block truncate">{o.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
