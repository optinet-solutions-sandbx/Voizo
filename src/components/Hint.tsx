"use client";

// One-line styled tooltip for the honesty disclosures (est chips, outcome chips, icon
// buttons) — replaces native `title=` (slow to appear, unstyled, easy to miss). Radix
// under the hood via components/ui/tooltip; the app-level TooltipProvider supplies the
// open delay. `asChild` merges the trigger props onto the child element, so wrap plain
// DOM elements (span/button) — custom components would need to forward props/refs.
import type { ReactNode } from "react";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";

export default function Hint({
  content,
  side,
  children,
}: {
  content: ReactNode;
  side?: "top" | "bottom" | "left" | "right";
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{content}</TooltipContent>
    </Tooltip>
  );
}
