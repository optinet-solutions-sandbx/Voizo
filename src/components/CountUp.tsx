"use client";

// Count-up numeral (motion): animates 0→value on mount and old→new on later changes, so the
// big dashboard totals "land" instead of appearing. Respects prefers-reduced-motion (plain
// value, no animation). The span's children carry the final value for first paint; the effect
// then drives textContent directly (no React re-render per frame).
import { useEffect, useRef } from "react";
import { animate, useMotionValue, useReducedMotion } from "motion/react";

export default function CountUp({ value, className }: { value: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const mv = useMotionValue(0);
  const reduced = useReducedMotion();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduced) {
      el.textContent = value.toLocaleString();
      return;
    }
    const controls = animate(mv, value, {
      duration: 0.7,
      ease: "easeOut",
      onUpdate: (v) => {
        el.textContent = Math.round(v).toLocaleString();
      },
    });
    return () => controls.stop();
  }, [value, reduced, mv]);

  return (
    <span ref={ref} className={className}>
      {value.toLocaleString()}
    </span>
  );
}
