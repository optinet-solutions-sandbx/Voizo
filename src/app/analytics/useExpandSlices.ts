"use client";

// Shared expand + slice state for campaign-row lists (CampaignTable, TodaysCampaigns) —
// the mockup's handleRowClick semantics in one place so the two surfaces can't drift:
//   · chevron/name toggle → expand unfiltered; collapsing clears the row's slice
//   · breakdown number click: same number while open → collapse; a different number →
//     re-slice in place (stays open); closed row → expand pre-filtered
// Lives apart from CampaignRow.tsx so that component file only exports a component.

import { useState } from "react";
import { sliceEq, type RecordSlice } from "./recordsDisplay";

export interface RowSlice {
  slice: RecordSlice;
  label: string;
}

export function useExpandSlices() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Active records slice per expanded row: absent = unfiltered.
  const [slices, setSlices] = useState<Record<string, RowSlice>>({});

  const clearSlice = (id: string) =>
    setSlices((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    if (expanded.has(id)) clearSlice(id); // pre-toggle value: the row WAS open → collapsing
  };

  const pickMetric = (id: string, slice: RecordSlice, label: string) => {
    const isOpen = expanded.has(id);
    if (isOpen && sliceEq(slices[id]?.slice ?? null, slice)) {
      setExpanded((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      clearSlice(id);
      return;
    }
    setSlices((prev) => ({ ...prev, [id]: { slice, label } }));
    if (!isOpen) setExpanded((prev) => new Set(prev).add(id));
  };

  return { expanded, slices, toggleExpand, pickMetric, clearSlice };
}
