"use client";

// Hover preview of a campaign's prompt — the first lines of its OPERATOR text in a floating
// card (click still opens the full PromptModal). Fetches on first open with a module-level
// per-campaign cache, so hovering across rows never refetches. Same endpoint as
// PromptVersionsPanel; we take the latest version.

import { useState, type ReactNode } from "react";
import { HoverCard, HoverCardTrigger, HoverCardContent } from "@/components/ui/hover-card";
import { operatorPromptText } from "@/lib/dashboardAnalytics";
import { BlockSkeleton } from "./loadingSkeletons";

const PREVIEW_CHARS = 600;

// campaignId → preview text; null = no snapshot / fetch failed (shown as an honest empty note).
const previewCache = new Map<string, string | null>();

export default function PromptHoverCard({
  campaignId,
  children,
}: {
  campaignId: string;
  children: ReactNode;
}) {
  // undefined = not fetched yet (skeleton while the first open is in flight).
  const [text, setText] = useState<string | null | undefined>(previewCache.get(campaignId));

  const onOpenChange = (open: boolean) => {
    if (!open) return;
    if (previewCache.has(campaignId)) {
      setText(previewCache.get(campaignId));
      return;
    }
    fetch(`/api/dashboard/campaigns/${campaignId}/prompt`, { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const b = (await r.json()) as { versions: Array<{ system_prompt: string }> };
        const raw = b.versions[0]?.system_prompt;
        const preview = raw ? operatorPromptText(raw).slice(0, PREVIEW_CHARS) : null;
        previewCache.set(campaignId, preview);
        setText(preview);
      })
      .catch(() => {
        previewCache.set(campaignId, null);
        setText(null);
      });
  };

  return (
    <HoverCard openDelay={250} closeDelay={100} onOpenChange={onOpenChange}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="bottom" align="start" className="w-80">
        {text === undefined ? (
          <BlockSkeleton lines={3} />
        ) : text === null ? (
          <p className="text-xs text-[var(--text-3)]">No prompt snapshot for this campaign.</p>
        ) : (
          <>
            <pre className="max-h-56 overflow-hidden font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-[var(--text-2)]">
              {text}
              {text.length >= PREVIEW_CHARS ? "…" : ""}
            </pre>
            <p className="mt-2 border-t border-[var(--border)] pt-2 text-[10px] text-[var(--text-3)]">
              Click to open the full prompt
            </p>
          </>
        )}
      </HoverCardContent>
    </HoverCard>
  );
}
