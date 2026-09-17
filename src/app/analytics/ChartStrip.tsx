"use client";

// The horizontally scrolling card strip (dashboard mockup, ported 2026-09-03): N cards on one
// rail, with page dots underneath. Replaces a grid that would otherwise become a wall. Scroll,
// swipe, trackpad and keyboard all work on the rail itself; the dots are a jump control and a
// position readout.
//
// 2026-09-17: the scrollbar-plus-arrows version read as dated (Jasiel), so the native scrollbar is
// hidden and the ‹ › buttons are gone. Dots only appear when something is actually out of view.
//
// Built for the four Global charts; the lane strip reuses it, which is why the noun, the card
// width and the id are props rather than literals.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

/** Literal class strings, one per supported density — Tailwind's scanner cannot see a width
 *  composed at runtime, so a computed `w-[calc(...)]` would simply never be generated. */
const CARD_W: Record<number, string> = {
  2: "[&>*]:w-[calc(50%-8px)]",
  3: "[&>*]:w-[calc(33.333%-11px)]",
  4: "[&>*]:w-[calc(25%-12px)]",
  5: "[&>*]:w-[calc(20%-13px)]",
};

const GAP = 16; // gap-4, the rail's own gap — the page arithmetic needs it as a number

export default function ChartStrip({
  children,
  count,
  noun = "charts",
  perView = 2,
  id = "global-chart-strip",
  cardClass,
}: {
  children: ReactNode;
  count: number;
  noun?: string;
  perView?: 2 | 3 | 4 | 5;
  id?: string;
  /** Overrides the per-view width with a fixed one, for cards that should size to their content
   *  instead of stretching to a fraction of the rail (a stretched card is dead space inside it). */
  cardClass?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState(1);
  const [page, setPage] = useState(0);

  /** How many cards fit, how many pages that makes, and how far the rail can actually travel.
   *  Memoized so the measure callback below can depend on it by identity — the React Compiler
   *  refuses to optimize a useCallback whose inferred deps disagree with the written ones. */
  const geom = useCallback(() => {
    const el = ref.current;
    const card = el?.firstElementChild as HTMLElement | null;
    if (!el || !card) return null;
    const cardW = card.getBoundingClientRect().width;
    if (cardW === 0 || el.clientWidth === 0) return null;
    const per = Math.max(1, Math.round((el.clientWidth + GAP) / (cardW + GAP)));
    // Pages come from the CARD COUNT, not from scrollWidth / clientWidth: that ratio is 2.01 for
    // four half-width cards and rounded up to a third "page" two pixels wide, which rendered a
    // third dot that scrolled nowhere.
    return { per, pages: Math.max(1, Math.ceil(count / per)), maxScroll: Math.max(0, el.scrollWidth - el.clientWidth) };
  }, [count]);

  const measure = useCallback(() => {
    const el = ref.current;
    const g = geom();
    if (!el || !g) return;
    setPages(g.pages);
    // Position is mapped across the SCROLLABLE RANGE, not in page-width units. The last page is
    // always short — the rail stops at its end rather than travelling a further full page — so
    // dividing by page width left the final dot permanently unreachable: it slid, and the small
    // dot stayed small. 0 maps to the first dot, the far end to the last, evenly in between.
    setPage(g.maxScroll <= 0 ? 0 : Math.round((el.scrollLeft / g.maxScroll) * (g.pages - 1)));
  }, [geom]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    // The strips mount before their content has laid out, so the first measurement can see a rail
    // with no width and no cards. Three things cover that, because each one alone has been caught
    // out: observers for content and size changes, and a short bounded retry for the case where
    // neither fires (a parent that starts display:none, fonts settling, async data).
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    const mo = new MutationObserver(measure);
    mo.observe(el, { childList: true, subtree: true });
    const timers = [0, 120, 400, 1000, 2000].map((ms) => window.setTimeout(measure, ms));
    return () => {
      el.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      ro.disconnect();
      mo.disconnect();
      timers.forEach(clearTimeout);
    };
  }, [count, measure]);

  const goto = (i: number) => {
    const el = ref.current;
    const g = geom();
    if (!el || !g) return;
    // The inverse of the mapping in measure(), so the dot you click is the dot that lights up.
    el.scrollTo({ left: g.pages > 1 ? (i / (g.pages - 1)) * g.maxScroll : 0, behavior: "smooth" });
  };

  return (
    // min-w-0: a grid/flex item defaults to min-width:auto, so the rail would size itself to its
    // content and never overflow — overflow-x-auto then scrolls nothing and no dots appear.
    <div className="min-w-0">
      <div
        id={id}
        ref={ref}
        role="region"
        tabIndex={0}
        aria-label={`${count} ${noun}. Scroll or swipe for the rest.`}
        // snap-proximity, not mandatory: mandatory fights a smooth programmatic scroll and lands it
        // with a jerk. scroll-smooth makes the dots animate rather than teleport.
        className={`flex min-w-0 gap-4 overflow-x-auto snap-x snap-proximity scroll-smooth hide-scrollbar max-lg:flex-col max-lg:overflow-visible [&>*]:snap-start [&>*]:shrink-0 max-lg:[&>*]:w-full ${cardClass ?? CARD_W[perView]}`}
      >
        {children}
      </div>

      {/* Only when something is actually out of view. Hidden below lg, where the rail stacks
          vertically and there is nothing to page through. */}
      {pages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-2.5 max-lg:hidden">
          {Array.from({ length: pages }, (_, i) => (
            <button
              key={i}
              type="button"
              onClick={() => goto(i)}
              aria-controls={id}
              aria-current={i === page}
              aria-label={`Show ${noun} ${i + 1} of ${pages}`}
              // The operator has to find these at a glance on a dark page, so the current page is a
              // full bar a couple of steps up the grey ladder — shape and brightness carry it, not
              // hue. The accent is reserved for state that means something (a collapsing lane).
              className={`h-2 rounded-full transition-all duration-200 ${
                i === page
                  ? "w-7 bg-[var(--text-2)]"
                  : "w-2 bg-[var(--border-2)] hover:bg-[var(--text-3)]"
              }`}
            />
          ))}
          <span className="ml-1 font-mono text-[10px] text-[var(--text-3)] tabular-nums">{page + 1}/{pages}</span>
        </div>
      )}
    </div>
  );
}
