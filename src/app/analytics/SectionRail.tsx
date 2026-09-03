"use client";

// Section rail (dashboard mockup, ported 2026-09-03): five jump links that stay pinned while the
// page scrolls, the current section marked. The page is long; the rail says where you are and
// takes you to the rest in one click. Desktop only: the phone layout has its own fixed header.
import { useEffect, useRef, useState } from "react";

// [anchor id, label, SectionTick colour]. The ids live on the sections in DashboardView and
// GlobalPerformance; a missing anchor is a dead link, so keep both lists in step.
export const SECTIONS: readonly [string, string, string][] = [
  ["sec-today", "Today", "#3ec08a"],
  ["global-performance", "Performance", "#5b9bf0"],
  ["sec-camps", "Campaigns", "#5b9bf0"],
  ["sec-heat", "Heatmap", "#5b9bf0"],
  ["sec-lead", "Leaders", "#5b9bf0"],
];

// The section whose top has passed the rail's bottom edge is the current one; the first section
// until any has. The scroller is the app's <main>, not the window, so listen there.
export function currentSection(tops: readonly (number | null)[], line: number): number {
  let cur = 0;
  tops.forEach((t, i) => { if (t !== null && t <= line) cur = i; });
  return cur;
}

export default function SectionRail() {
  const ref = useRef<HTMLElement>(null);
  const [current, setCurrent] = useState(0);

  useEffect(() => {
    const rail = ref.current;
    if (!rail) return;
    const scroller: HTMLElement | Window = rail.closest("main") ?? window;
    let frame = 0;
    const update = () => {
      frame = 0;
      const line = rail.getBoundingClientRect().bottom + 8;
      const tops = SECTIONS.map(([id]) => document.getElementById(id)?.getBoundingClientRect().top ?? null);
      setCurrent(currentSection(tops, line));
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(update); };
    update();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => { scroller.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, []);

  return (
    <nav ref={ref} aria-label="Sections" className="hidden md:flex sticky top-0 z-30 -mt-4 pt-4 h-[52px] items-center gap-0.5 bg-[var(--bg-app)]">
      {SECTIONS.map(([id, label, color], i) => (
        <button
          key={id}
          type="button"
          aria-current={i === current ? "true" : undefined}
          onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-[11.5px] border transition-colors ${
            i === current
              ? "text-[var(--text-1)] border-[var(--border-2)] bg-[var(--bg-elevated)]"
              : "text-[var(--text-3)] border-transparent hover:text-[var(--text-2)] hover:bg-[var(--bg-hover)]"
          }`}
        >
          <i aria-hidden className="inline-block w-1.5 h-1.5 rounded-[2px]" style={{ background: color }} />
          {label}
        </button>
      ))}
    </nav>
  );
}
