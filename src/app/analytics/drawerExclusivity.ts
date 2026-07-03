"use client";

// Cross-section drawer exclusivity (Val's mockup `openDrawer`: opening any of the three
// stat-card record drawers — Today / Global / Top performers — closes the other two).
// Tiny module-scope emitter: an owner CLAIMS when its drawer opens; every other
// subscriber closes itself. Campaign-row expands do NOT participate (the mockup keeps
// those independent of the drawers).

import { useEffect } from "react";

type Listener = (owner: string) => void;
const listeners = new Set<Listener>();

/** Announce that `owner`'s drawer just opened. Snapshot the set so a listener
 *  unsubscribing mid-dispatch can't skip the others. */
export function claimDrawer(owner: string): void {
  for (const l of [...listeners]) l(owner);
}

/** Subscribe to claims; returns the unsubscribe. */
export function onDrawerClaim(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** React wiring: claim on open; close self when a DIFFERENT owner claims.
 *  `closeSelf` must be referentially stable (useCallback) — it's an effect dep. */
export function useDrawerClaim(owner: string, open: boolean, closeSelf: () => void): void {
  useEffect(() => {
    if (open) claimDrawer(owner);
  }, [owner, open]);
  useEffect(
    () =>
      onDrawerClaim((claimer) => {
        if (claimer !== owner) closeSelf();
      }),
    [owner, closeSelf],
  );
}
