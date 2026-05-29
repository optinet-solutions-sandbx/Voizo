"use client";
import { useEffect, useRef } from "react";
import { useReducedMotion } from "motion/react";
import type { AnimatedIcon, AnimatedIconHandle } from "./types";

/**
 * Wraps an animated icon and plays its animation whenever the icon's nearest
 * <button>/<a> ancestor is hovered — not just the icon itself. Lets us upgrade
 * any existing icon button to full-button hover with a one-line swap, with no
 * hook placement or handler wiring at the call site, so it works even inside
 * IIFEs, .map()s, and conditional renders:
 *
 *   <PlusIcon size={15} />   ->   <HoverIcon icon={PlusIcon} size={15} />
 *
 * The wrapper span is display:contents, so it does not affect flex/gap layout.
 * Honors prefers-reduced-motion (no animation when the user opts out).
 */
export function HoverIcon({
  icon: Icon,
  size,
  className,
}: {
  icon: AnimatedIcon;
  size?: number;
  className?: string;
}) {
  const handleRef = useRef<AnimatedIconHandle>(null);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const reduce = useReducedMotion();

  useEffect(() => {
    // Host is resolved once, at mount. If a call site's nearest button/anchor
    // can change identity while this stays mounted, remount HoverIcon via `key`
    // so it rebinds its listeners to the new host.
    const host = anchorRef.current?.closest("button, a, [role='button']");
    if (!host) return;
    const enter = () => { if (!reduce) handleRef.current?.startAnimation(); };
    const leave = () => { handleRef.current?.stopAnimation(); };
    host.addEventListener("mouseenter", enter);
    host.addEventListener("mouseleave", leave);
    return () => {
      host.removeEventListener("mouseenter", enter);
      host.removeEventListener("mouseleave", leave);
    };
  }, [reduce]);

  return (
    <span ref={anchorRef} style={{ display: "contents" }}>
      <Icon ref={handleRef} size={size} className={className} />
    </span>
  );
}
