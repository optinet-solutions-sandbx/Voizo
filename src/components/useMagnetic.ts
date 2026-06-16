"use client";

// "Magnetic" hover: the element leans toward the pointer, springs back on leave. Implemented as a
// CALLBACK REF so the pointer listeners + transform are wired at commit time (not render) — keeps
// transform mutations off React's render path (pointermove fires a lot) and satisfies the
// react-hooks/refs rule. Honors prefers-reduced-motion. Pure offset math lives in lib/magnet.

import { useCallback, useRef } from "react";
import { useReducedMotion } from "motion/react";
import { magnetOffset } from "@/lib/magnet";

export function useMagnetic<T extends HTMLElement = HTMLDivElement>(strength = 0.22, max = 11) {
  const reduce = useReducedMotion();
  const cleanupRef = useRef<(() => void) | null>(null);

  // Callback ref: runs at commit with the node (or null on unmount / before re-attach).
  return useCallback(
    (node: T | null) => {
      cleanupRef.current?.();
      cleanupRef.current = null;
      if (!node || reduce) return;

      const onMove = (e: PointerEvent) => {
        const r = node.getBoundingClientRect();
        const { x, y } = magnetOffset(
          { left: r.left, top: r.top, width: r.width, height: r.height },
          e.clientX,
          e.clientY,
          { strength, max },
        );
        node.style.transition = "transform 80ms linear";
        node.style.transform = `translate(${x}px, ${y}px)`;
      };
      const onLeave = () => {
        node.style.transition = "transform 350ms cubic-bezier(.2,.7,.2,1)";
        node.style.transform = "";
      };

      node.addEventListener("pointermove", onMove);
      node.addEventListener("pointerleave", onLeave);
      cleanupRef.current = () => {
        node.removeEventListener("pointermove", onMove);
        node.removeEventListener("pointerleave", onLeave);
        node.style.transform = "";
      };
    },
    [reduce, strength, max],
  );
}
