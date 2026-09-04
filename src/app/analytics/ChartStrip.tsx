"use client";

// The Global chart strip (dashboard mockup, ported 2026-09-03): the charts as ONE horizontally
// scrolling strip, two cards visible at a time, with previous / next buttons and a "N charts ·
// 2 shown" counter. Replaces the two-up grid that would have become a four-up wall. Scroll or
// swipe works on its own; the buttons nudge by one card. Charts stack vertically under 1024px.
import { useEffect, useRef, useState, type ReactNode } from "react";

export default function ChartStrip({ children, count }: { children: ReactNode; count: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);
  const measure = () => {
    const el = ref.current;
    if (!el) return;
    setAtStart(el.scrollLeft <= 2);
    setAtEnd(el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  };
  useEffect(() => {
    measure();
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => { el.removeEventListener("scroll", measure); window.removeEventListener("resize", measure); };
  }, [count]);
  const nudge = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const card = el.firstElementChild as HTMLElement | null;
    const step = card ? card.getBoundingClientRect().width + 16 : el.clientWidth / 2;
    el.scrollBy({ left: dir * step, behavior: "smooth" });
  };
  return (
    <div>
      <div className="flex items-center justify-end gap-1.5 mb-1.5 text-[11px] text-[var(--text-3)]">
        <span className="font-mono mr-1">{count} charts · 2 shown</span>
        <button type="button" onClick={() => nudge(-1)} disabled={atStart} aria-controls="global-chart-strip" aria-label="Show the previous chart"
          className="w-6 h-6 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:cursor-not-allowed">‹</button>
        <button type="button" onClick={() => nudge(1)} disabled={atEnd} aria-controls="global-chart-strip" aria-label="Show the next chart"
          className="w-6 h-6 rounded-md border border-[var(--border)] text-[var(--text-2)] hover:text-[var(--text-1)] hover:bg-[var(--bg-hover)] disabled:opacity-35 disabled:cursor-not-allowed">›</button>
      </div>
      <div
        id="global-chart-strip"
        ref={ref}
        role="region"
        tabIndex={0}
        aria-label={`Global charts, ${count} cards, two shown at a time. Scroll or swipe for the rest.`}
        className="flex gap-4 overflow-x-auto snap-x snap-mandatory pb-1 [scrollbar-width:thin] max-lg:flex-col max-lg:overflow-visible [&>*]:snap-start [&>*]:shrink-0 [&>*]:w-[calc(50%-8px)] max-lg:[&>*]:w-full"
      >
        {children}
      </div>
    </div>
  );
}
