// Shared range → [startMs, endMs] window resolver for the Global Performance filter.
// One place so the analytics cards/charts, the records drawer, and the exports all interpret
// a range the same way — presets (7d…90d), "lifetime" (all time), or a custom from/to date pair.
// Zero-trust: unknown range → 30-day default; unparseable custom dates fall back to the preset.

export const MS_PER_DAY = 86_400_000;

// Preset windows. "lifetime" and "custom" are handled specially in rangeToWindow (not day-counts).
export const RANGE_DAYS: Record<string, number> = { "7d": 7, "14d": 14, "30d": 30, "60d": 60, "90d": 90 };

export type RangeKey = "7d" | "14d" | "30d" | "60d" | "90d" | "lifetime" | "custom";

// The range values a request may legitimately send as `?range=` (custom is expressed via from/to, not here).
export const RANGE_PRESETS: readonly string[] = ["7d", "14d", "30d", "60d", "90d", "lifetime"];

/**
 * Resolve a range selection to a concrete [startMs, endMs] window.
 *
 * - A valid `from`+`to` pair WINS (custom range): order-agnostic, `to` is inclusive to end-of-day,
 *   and the window never extends past `now`.
 * - `"lifetime"` → from the epoch to now (all data).
 * - Any preset key → the last N days to now. Unknown → 30 days (safe default).
 */
export function rangeToWindow(
  range: string,
  now: number,
  from?: string | null,
  to?: string | null,
): { startMs: number; endMs: number } {
  const s = from ? Date.parse(from) : NaN;
  const e = to ? Date.parse(to) : NaN;
  if (Number.isFinite(s) && Number.isFinite(e)) {
    const startMs = Math.min(s, e);
    // `to` is a date (midnight); include the whole day, and never let a future `to` reach past now.
    const endMs = Math.min(now, Math.max(s, e) + MS_PER_DAY - 1);
    return { startMs, endMs };
  }
  if (range === "lifetime") return { startMs: 0, endMs: now };
  const days = RANGE_DAYS[range] ?? 30;
  return { startMs: now - days * MS_PER_DAY, endMs: now };
}
