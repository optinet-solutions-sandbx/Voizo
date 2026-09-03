"use client";

// Page-level brand scope (dashboard mockup, ported 2026-09-03). The page opens on ALL brands
// (Jasiel 2026-09-03, overriding the mockup's one-brand default); picking a brand isolates every
// section to it, and the choice is remembered per browser and shared across tabs. "" = all
// brands. Same external-store pattern as the sidebar lock, so the server and the first client
// paint agree on the default.
import { useSyncExternalStore } from "react";

export const ALL_BRANDS = "";
const KEY = "voizo-brand";
const EVENT = "voizo-brand-change";

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** The stored choice; a browser that never chose gets all brands. */
export function readBrandScope(): string {
  try {
    return localStorage.getItem(KEY) ?? ALL_BRANDS;
  } catch {
    return ALL_BRANDS;
  }
}

export function useBrandScope(): string {
  return useSyncExternalStore(subscribe, readBrandScope, () => ALL_BRANDS);
}

export function setBrandScope(brand: string): void {
  try { localStorage.setItem(KEY, brand); } catch { /* private mode: the choice lasts this page only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}
