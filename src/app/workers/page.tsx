// src/app/workers/page.tsx
//
// Workers landing — 3D globe view of the anonymous-slot pool.
// Replaces the prior flat-map + table layout with:
//   - 3D orthographic globe (drag to rotate)
//   - Worker Pool side panel on the right, bidirectional sync with pins
//   - Floating worker card anchored to the selected pin
//   - Country hover tooltip showing local time
//
// Data: GET /api/workers/state polled every 5s (per design doc §5.2),
// pins update reactively. Free workers stay in the panel but don't pin.

"use client";

import { Suspense, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertCircle, Loader2 } from "lucide-react";
import { useTheme } from "@/lib/themeContext";

import Globe from "./Globe";
import WorkerPoolPanel from "./WorkerPoolPanel";
import WorldClocks from "./WorldClocks";
import CollapsibleColumn from "./CollapsibleColumn";
import { useWorkersState } from "./use-workers-state";
import { useNow } from "./use-now";

// Suspense wrapper required by Next.js when a page uses useSearchParams in
// a statically-prerenderable client component. The inner WorkersPageInner
// reads ?focus=<slot> on mount (P4); Next would otherwise bail the static
// prerender. Fallback shows the same loader as the data-loading state.
export default function WorkersPage() {
  return (
    <Suspense
      fallback={
        <div className="relative h-full flex items-center justify-center">
          <div className="flex items-center gap-2 text-[var(--text-3)] text-sm">
            <Loader2 size={16} className="animate-spin" />
            Loading worker pool…
          </div>
        </div>
      }
    >
      <WorkersPageInner />
    </Suspense>
  );
}

function WorkersPageInner() {
  const { isDark } = useTheme();
  const now = useNow();
  const { data, loading, error } = useWorkersState();
  const searchParams = useSearchParams();

  const slots = data?.slots ?? [];

  // Cross-component selection state (shared between Globe + Panel)
  const [hoveredSlotIndex, setHoveredSlotIndex] = useState<number | null>(null);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);

  // P4: ?focus=<slot> arrives when an operator clicks a worker on the
  // dashboard mini-list. Seed selectedSlotIndex on mount so Globe's
  // pan-to-pin effect animates to that worker's location. Mount-only —
  // navigating away and back is treated as a fresh entry.
  useEffect(() => {
    const focusParam = searchParams.get("focus");
    if (!focusParam) return;
    const idx = Number.parseInt(focusParam, 10);
    if (Number.isFinite(idx) && idx >= 0) {
      setSelectedSlotIndex(idx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Header / status counts
  const onCall = slots.filter(s => s.status === "leased" && s.inFlightCall).length;
  const leased = slots.filter(s => s.status === "leased").length;
  const free   = slots.filter(s => s.status === "free").length;
  const maint  = slots.filter(s => s.status === "maintenance").length;

  // Initial-load skeleton — globe doesn't paint until features arrive
  if (loading && !data) {
    return (
      <div className="relative h-full flex items-center justify-center">
        <div className="flex items-center gap-2 text-[var(--text-3)] text-sm">
          <Loader2 size={16} className="animate-spin" />
          Loading worker pool…
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full overflow-hidden">
      {/* Globe layer — fills the page */}
      <div className="absolute inset-0">
        <Globe
          slots={slots}
          now={now}
          hoveredSlotIndex={hoveredSlotIndex}
          selectedSlotIndex={selectedSlotIndex}
          onSlotHover={setHoveredSlotIndex}
          onSlotSelect={setSelectedSlotIndex}
          theme={isDark ? "dark" : "light"}
        />
      </div>

      {/* Top-left stats chip (floats over globe) */}
      <div className="absolute top-4 left-16 z-10 flex flex-wrap items-center gap-3 bg-[var(--bg-card)]/85 backdrop-blur-xl border border-[var(--border)] rounded-xl px-4 py-2.5 text-xs">
        <span className="inline-flex items-center gap-2 text-[var(--text-2)]">
          <span className="relative w-2 h-2 rounded-full bg-blue-500">
            <span className="absolute inset-0 rounded-full bg-blue-500 animate-ping opacity-50" />
          </span>
          <strong className="text-[var(--text-1)] font-semibold">{onCall}</strong>
          <span className="text-[var(--text-3)]">/{slots.length || 5} active</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-[var(--text-2)]">
          <span className="w-2 h-2 rounded-full bg-amber-500" />
          {leased - onCall} idle
        </span>
        <span className="inline-flex items-center gap-1.5 text-[var(--text-2)]">
          <span className="w-2 h-2 rounded-full bg-slate-400" />
          {free} free
        </span>
        {maint > 0 && (
          <span className="inline-flex items-center gap-1.5 text-[var(--text-2)]">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            {maint} maintenance
          </span>
        )}
        {error && (
          <span className="inline-flex items-center gap-1.5 text-amber-400 border-l border-[var(--border)] pl-3">
            <AlertCircle size={12} />
            {error}
          </span>
        )}
      </div>

      {/* Worker Pool side panel — locked open by default (primary content) */}
      <CollapsibleColumn
        side="right"
        storageKey="workers-pool-locked"
        defaultLocked={true}
        width={360}
        railLabels={["WORKER POOL"]}>
        <WorkerPoolPanel
          slots={slots}
          now={now}
          hoveredSlotIndex={hoveredSlotIndex}
          selectedSlotIndex={selectedSlotIndex}
          onSlotHover={setHoveredSlotIndex}
          onSlotSelect={setSelectedSlotIndex}
        />
      </CollapsibleColumn>

      {/* World Clocks side panel — auto-collapse by default (secondary) */}
      <CollapsibleColumn
        side="left"
        storageKey="workers-clocks-locked"
        defaultLocked={false}
        width={300}
        railLabels={["WORLD CLOCKS"]}>
        <WorldClocks now={now} />
      </CollapsibleColumn>

      {/* Hint + sync stamp */}
      <div className="absolute bottom-4 left-4 z-10 text-[11px] text-[var(--text-3)] font-mono pointer-events-none">
        Drag to navigate <span className="opacity-50 mx-1">·</span> Click pin to inspect <span className="opacity-50 mx-1">·</span> Scroll to zoom
      </div>
      <div className="absolute bottom-4 right-4 z-10 text-[11px] text-[var(--text-3)] font-mono inline-flex items-center gap-2">
        <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 shadow-[0_0_6px] shadow-emerald-500/60 animate-pulse" />
        Live · synced {new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true }).format(now)}
      </div>
    </div>
  );
}
