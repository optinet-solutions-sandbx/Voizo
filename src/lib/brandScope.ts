"use client";

// Page-level brand scope (dashboard mockup, ported 2026-09-03). One brand at a time is what an
// operator gets unless they ask for "All brands" (Play spec ruling 3); the choice is remembered
// per browser and shared across tabs. "" = all brands. Same external-store pattern as the
// sidebar lock, so the server and the first client paint agree on the default.
import { useSyncExternalStore } from "react";
import { DEFAULT_BRAND_WORKSPACE } from "./campaignDisplay";

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

/** The stored choice; a browser that never chose gets the default brand, not all brands. */
export function readBrandScope(): string {
  try {
    const v = localStorage.getItem(KEY);
    return v === null ? DEFAULT_BRAND_WORKSPACE : v;
  } catch {
    return DEFAULT_BRAND_WORKSPACE;
  }
}

export function useBrandScope(): string {
  return useSyncExternalStore(subscribe, readBrandScope, () => DEFAULT_BRAND_WORKSPACE);
}

export function setBrandScope(brand: string): void {
  try { localStorage.setItem(KEY, brand); } catch { /* private mode: the choice lasts this page only */ }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(EVENT));
}
