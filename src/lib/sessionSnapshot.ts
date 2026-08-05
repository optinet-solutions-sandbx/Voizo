// Generic sessionStorage snapshot for stale-while-revalidate first paints
// (2026-08-05, the /campaigns pattern generalized). A component hydrates
// instantly from the last session's response, then refetches in the background
// and overwrites the snapshot — tab switches paint at once instead of staring
// at a spinner while a heavy route recomputes.
//
// Contract: NEVER throws. Corrupt JSON, quota, disabled storage, or SSR
// (no sessionStorage) all degrade to null / a console.warn — callers then
// behave exactly as if no snapshot existed. Hydrate from a useEffect, never
// from a useState initializer: these components are SSR'd, and a server/client
// first-render mismatch is a hydration error.
//
// sessionStorage, not localStorage: a browser restart starts clean, so a
// snapshot never outlives the session that wrote it.

const PREFIX = "voizo.snap.v1:";

/** Last snapshot for `key`, or null (absent / corrupt / storage unavailable). */
export function loadSnapshot<T>(key: string): T | null {
  try {
    const raw = sessionStorage.getItem(PREFIX + key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

/** Overwrite the snapshot for `key`; a failed write warns, never throws. */
export function saveSnapshot(key: string, data: unknown): void {
  try {
    sessionStorage.setItem(PREFIX + key, JSON.stringify(data));
  } catch (err) {
    console.warn(`[sessionSnapshot] save failed for ${key}:`, err);
  }
}
