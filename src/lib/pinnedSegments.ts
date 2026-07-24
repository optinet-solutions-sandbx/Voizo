"use client";

// 2026-05-22: Per-operator pinned segments for the wizard's Step 1 source
// picker. Localstorage-backed (no DB), per-source (CIO IDs separate from
// Voizo UUIDs to avoid collision). The hook keeps a useState mirror of the
// persisted set + subscribes to a module-level event emitter so multiple
// importers (e.g., Tab A's CIO importer + a future popover) see the same
// pinned set without prop-drilling.
//
// Storage keys: voizo:pinned-<source>-segments — "cio" and "voizo" keep their
// original keys byte-identical (operators' existing pins survive). VOZ-201
// adds workspace-scoped sources ("cio:fortuneplay") because CIO segment ids
// are only unique per workspace — a pinned FP 406 must not pin an L7 406.

import { useEffect, useState, useCallback } from "react";

/** "cio" | "voizo" | "cio:<workspace>" (VOZ-201 brand-scoped pins). */
export type PinSource = string;

const storageKeyFor = (source: PinSource): string => `voizo:pinned-${source}-segments`;

// Module-level emitter so toggles in one component update other subscribers.
// Lazily keyed (VOZ-201: sources are dynamic now).
const listeners = new Map<PinSource, Set<() => void>>();
function listenersFor(source: PinSource): Set<() => void> {
  let set = listeners.get(source);
  if (!set) {
    set = new Set();
    listeners.set(source, set);
  }
  return set;
}

function readFromStorage(source: PinSource): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(storageKeyFor(source));
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
    window.localStorage.setItem(storageKeyFor(source), JSON.stringify(Array.from(set)));
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
  for (const fn of listenersFor(source)) fn();
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
    // Re-read on source change (VOZ-201: the importer's source flips when the
    // operator switches brand — the state must follow, not just the listener).
    setPinned(readFromStorage(source));
    const handler = () => setPinned(readFromStorage(source));
    const set = listenersFor(source);
    set.add(handler);
    return () => {
      set.delete(handler);
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
