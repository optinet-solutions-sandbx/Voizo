// PURE math for the "magnetic" card hover: how far an element should translate toward the
// pointer. Kept framework-free so it's unit-testable; the useMagnetic hook applies the result.

export interface MagnetRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface MagnetOpts {
  strength?: number; // fraction of the pointer-to-center distance to follow (default 0.3)
  max?: number; // clamp the translate to ±max px so far pointers don't fling the card (default 14)
}

const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v));

/** Translate (px) an element should shift so it leans toward the pointer, clamped to ±max. */
export function magnetOffset(
  rect: MagnetRect,
  pointerX: number,
  pointerY: number,
  opts: MagnetOpts = {},
): { x: number; y: number } {
  const { strength = 0.3, max = 14 } = opts;
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;
  return {
    x: clamp((pointerX - cx) * strength, max),
    y: clamp((pointerY - cy) * strength, max),
  };
}
