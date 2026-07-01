// Presentational section "island" — a rounded, accent-tinted container that visually fences a
// dashboard group (emerald = Today / blue = Global), per Val's endgame mockup. ADAPTED to our theme:
// tints/borders use Tailwind accent presets over our token surfaces, NOT the mockup's hardcoded hexes,
// so the dashboard stays consistent with sibling pages. Pure layout shell — no state, no logic.

import type { ReactNode } from "react";

// Accent styling defined once per accent so the two islands stay in lock-step.
const ACCENT = {
  emerald: { border: "border-emerald-500/20", fill: "bg-emerald-500/5", glow: "from-emerald-500/10" },
  blue: { border: "border-blue-500/20", fill: "bg-blue-500/5", glow: "from-blue-500/10" },
} as const;

export default function SectionIsland({
  accent,
  children,
}: {
  accent: keyof typeof ACCENT;
  children: ReactNode;
}) {
  const a = ACCENT[accent];
  return (
    <section className={`relative overflow-hidden rounded-3xl border ${a.border} ${a.fill} p-5 sm:p-6`}>
      {/* Faint top-edge accent glow — echoes the mockup's colored islands without shouting. Decorative. */}
      <div className={`pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b ${a.glow} to-transparent`} aria-hidden />
      {/* Content sits above the glow; inherits the dashboard's 20px vertical rhythm. */}
      <div className="relative grid gap-5">{children}</div>
    </section>
  );
}
