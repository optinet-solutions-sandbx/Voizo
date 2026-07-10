"use client";

// Today's Performance — 3-card redesign (Val's "endgame dashboard" mockup, 2026-06-29). Renders the
// shared PerformanceCards grid (showDeltas=true) plus the Today/Yesterday toggle, the Active-Agents
// chip, and the inline records drawer. Every total/row/sub-row click maps to a SEMANTIC drawer filter
// (spec §6) and opens TodayRecordsDrawer below the cards. Data: TodaySnapshot.today / .yesterday from
// /api/dashboard/today (computeToday). The presentational pieces now live in PerformanceCards (shared
// with the ranged Global Performance view, Slice B 2026-06-30).

import { useCallback, useMemo, useState } from "react";
import type { TodaySnapshot, TodayPerfDay, PerfRow } from "@/lib/dashboardAnalytics";
import PerformanceCards from "./PerformanceCards";
import TodayRecordsDrawer, { type DrawerFilter } from "./TodayRecordsDrawer";
import { useDrawerClaim } from "./drawerExclusivity";
import { CardGridSkeleton } from "./loadingSkeletons";

// Map a clicked total/row to the semantic drawer filter (spec §6 — NOT the mockup's loose args).
function totalFilter(card: "callAttempts" | "reached" | "sms"): DrawerFilter {
  if (card === "reached") return { status: "all", outcome: "reached", smsOnly: false, title: "Reached contacts" };
  if (card === "sms") return { status: "all", outcome: "all", smsOnly: true, title: "SMS sent" };
  return { status: "all", outcome: "all", smsOnly: false, title: "All call records" };
}
function rowFilter(card: "callAttempts" | "reached" | "sms", rowKey: string, label: string): DrawerFilter {
  const outcome = rowKey as DrawerFilter["outcome"]; // row keys are AttemptTag | "reached"
  const smsOnly = card === "sms";
  const title = smsOnly ? `SMS: ${label.toLowerCase()}` : label;
  return { status: "all", outcome, smsOnly, title };
}

export default function TodayPerformanceCards({ data }: { data: TodaySnapshot | null }) {
  const [day, setDay] = useState<"today" | "yesterday">("today");
  const [filter, setFilter] = useState<DrawerFilter | null>(null);

  // Drawer exclusivity (mockup): opening this drawer closes the Global / Top-performers ones.
  const closeSelf = useCallback(() => setFilter(null), []);
  useDrawerClaim("today", filter !== null, closeSelf);

  const perf: TodayPerfDay | null = data ? data[day] : null;

  // Close the drawer when switching the day (its records are day-scoped).
  const switchDay = (d: "today" | "yesterday") => { setDay(d); setFilter(null); };

  // Re-clicking the slice that's already open closes the drawer (toggle) — status+outcome+smsOnly
  // identify a slice; the title is derived so it's ignored.
  const sameSlice = (a: DrawerFilter | null, b: DrawerFilter) =>
    !!a && a.status === b.status && a.outcome === b.outcome && a.smsOnly === b.smsOnly;
  const openTotal = (card: "callAttempts" | "reached" | "sms") =>
    setFilter((prev) => { const next = totalFilter(card); return sameSlice(prev, next) ? null : next; });
  const openRow = (card: "callAttempts" | "reached" | "sms", row: PerfRow) =>
    setFilter((prev) => { const next = rowFilter(card, row.key, row.label); return sameSlice(prev, next) ? null : next; });

  const toggle = useMemo(
    () => (
      <div className="inline-flex items-center gap-0.5 bg-[var(--bg-elevated)] border border-[var(--border)] rounded-lg p-0.5">
        {(["today", "yesterday"] as const).map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => switchDay(d)}
            className={`px-2.5 py-1 rounded-md text-[11px] font-medium capitalize transition-colors ${
              day === d ? "bg-[var(--bg-hover)] text-[var(--text-1)]" : "text-[var(--text-3)] hover:text-[var(--text-2)]"
            }`}
          >
            {d}
          </button>
        ))}
      </div>
    ),
    [day],
  );

  return (
    <section className="grid gap-3">
      {/* Control row: Today/Yesterday toggle. The agents-active chip now lives in the section
          header (next to Refresh) for mockup parity (Jasiel 2026-07-03). */}
      <div className="flex items-center gap-3 flex-wrap">
        {toggle}
      </div>

      {!perf ? (
        <CardGridSkeleton />
      ) : (
        <>
          <PerformanceCards perf={perf} showDeltas onOpenTotal={openTotal} onOpenRow={openRow} />
          <TodayRecordsDrawer day={day} filter={filter} onClose={() => setFilter(null)} />
        </>
      )}
    </section>
  );
}
