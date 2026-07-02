"use client";

// Shaped shimmer placeholders (shadcn Skeleton) replacing the plain "Loading…" texts on the
// dashboard tab. Each mirrors the rough silhouette of the content it stands in for, so the
// page doesn't reflow when real data lands. Presentational only.

import { Skeleton } from "@/components/ui/skeleton";

/** The 3-card Performance grid (Today + Global). */
export function CardGridSkeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-start">
      {[0, 1, 2].map((i) => (
        <div key={i} className="bg-[var(--bg-card)] border border-[var(--border)] rounded-2xl p-5">
          <Skeleton className="h-3 w-20 mb-3" />
          <Skeleton className="h-8 w-24 mb-4" />
          <div className="grid gap-2.5">
            <Skeleton className="h-3.5 w-full" />
            <Skeleton className="h-3.5 w-5/6" />
            <Skeleton className="h-3.5 w-4/6" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Campaign Performance table rows (matches the row rhythm, not the exact grid). */
export function CampaignRowsSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-start gap-4 px-4 py-4 border-b border-[var(--border)] last:border-b-0">
          <div className="flex-1 grid gap-2">
            <Skeleton className="h-4 w-2/5" />
            <Skeleton className="h-3 w-1/4" />
          </div>
          <Skeleton className="h-5 w-20 rounded-full" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
          <Skeleton className="h-10 w-28" />
        </div>
      ))}
    </div>
  );
}

/** Records table (header bar + a few rows). */
export function RecordsSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="rounded-xl border border-[var(--border)] p-3 grid gap-2.5">
      <Skeleton className="h-4 w-full" />
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full" />
      ))}
    </div>
  );
}

/** Generic small block (advanced analytics, modal bodies). */
export function BlockSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="grid gap-2.5 py-2">
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={`h-4 ${i === lines - 1 ? "w-3/5" : "w-full"}`} />
      ))}
    </div>
  );
}
