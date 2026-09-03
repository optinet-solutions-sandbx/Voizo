// Neutral section panel + accent tick (pattern brief §1, 2026-07-02): zones are marked by a
// small colored tick in the heading, NOT a full background wash — every surface sits on the
// same neutral elevation ladder. SectionIsland is now a plain bordered panel (--bg-panel);
// SectionTick renders the 9px rounded-square zone marker for section headings.

import type { ReactNode } from "react";

/** 9px rounded-square zone marker with a soft glow — place before a section heading. */
export function SectionTick({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      className="inline-block h-[9px] w-[9px] shrink-0 rounded-[3px]"
      style={{ background: color, boxShadow: `0 0 10px ${color}99` }}
    />
  );
}

// `id` makes the panel addressable (deep links, probes); scroll-mt keeps a jumped-to panel clear of the top edge.
export default function SectionIsland({ children, id }: { children: ReactNode; id?: string }) {
  return (
    <section id={id} className="rounded-[18px] border border-[var(--border)] bg-[var(--bg-panel)] p-4 sm:p-5 scroll-mt-14">
      <div className="grid gap-4">{children}</div>
    </section>
  );
}
