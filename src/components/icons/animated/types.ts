import type { ForwardRefExoticComponent, HTMLAttributes, RefAttributes } from "react";

// Shared shape for the lucide-animated icon components. Each one is a forwardRef
// that exposes these two imperative methods (see the *.tsx siblings) and accepts
// a `size` plus standard div attributes. Used wherever we drive an icon's
// animation from a parent hover (sidebar rows, header buttons, etc.).
export type AnimatedIconHandle = { startAnimation: () => void; stopAnimation: () => void };

export type AnimatedIcon = ForwardRefExoticComponent<
  HTMLAttributes<HTMLDivElement> & { size?: number } & RefAttributes<AnimatedIconHandle>
>;
