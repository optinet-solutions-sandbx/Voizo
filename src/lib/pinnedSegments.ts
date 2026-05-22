"use client";

// 2026-05-22: Per-operator pinned segments for the wizard's Step 1 source
// picker. Localstorage-backed (no DB), per-source (CIO IDs separate from
// Voizo UUIDs to avoid collision). The hook keeps a useState mirror of the
// persisted set + subscribes to a module-level event emitter so multiple
// importers (e.g., Tab A's CIO importer + a future popover) see the same
// pinned set without prop-drilling.
//
// Storage keys: voizo:pinned-cio-segments, voizo:pinned-voizo-segments.
// Both stored as JSON-serialized arrays of strings (CIO id -> String(num),
// Voizo uuid as-is).

import { useEffect, useState, useCallback } from "react";

export type PinSource = "cio" | "voizo";

const STORAGE_KEY: Record<PinSource, string> = {
  cio: "voizo:pinned-cio-segments",
  voizo: "voizo:pinned-voizo-segments",
};

// Module-level emitter so toggles in one component update other subscribers.
const listeners: Record<PinSource, Set<() => void>> = {
  cio: new Set(),
  voizo: new Set(),
};

function readFromStorage(source: PinSource): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY[source]);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return new Set();
    return new Set(arr.filter((v): v is string => typeof v === "string"));
  } catch (err) {
    console.warn(`[pinnedSegments] read failed for ${source}:`, err);
    return new Set();
  }
}

function writeToStorage(source: PinSource, set: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY[source], JSON.stringify(Array.from(set)));
  } catch (err) {
    console.warn(`[pinnedSegments] write failed for ${source}:`, err);
  }
}

/** Returns a snapshot of the pinned set for a source. Safe at SSR (empty). */
export function getPinnedSegments(source: PinSource): Set<string> {
  return readFromStorage(source);
}

/** Toggles pin state for a segment. Persists + notifies subscribers.
 *  Returns the new set. */
export function togglePinnedSegment(source: PinSource, id: string): Set<string> {
  const current = readFromStorage(source);
  if (current.has(id)) current.delete(id);
  else current.add(id);
  writeToStorage(source, current);
  for (const fn of listeners[source]) fn();
  return current;
}

/** React hook: subscribe to pin changes for a source. Returns the current
 *  set + a toggle function. Re-renders whenever any caller toggles a pin
 *  on the same source. */
export function usePinnedSegments(
  source: PinSource,
): [Set<string>, (id: string) => void] {
  const [pinned, setPinned] = useState<Set<string>>(() => readFromStorage(source));

  useEffect(() => {
    const handler = () => setPinned(readFromStorage(source));
    listeners[source].add(handler);
    return () => {
      listeners[source].delete(handler);
    };
  }, [source]);

  const toggle = useCallback(
    (id: string) => {
      togglePinnedSegment(source, id);
    },
    [source],
  );

  return [pinned, toggle];
}
