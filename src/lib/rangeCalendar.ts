// The window picker's arithmetic (dashboard mockup, ported 2026-09-03). One calendar for
// Campaign Performance's own range and Global Performance's Custom range: day, week, month,
// year or an arbitrary range, each compiling to ONE from→to pair, which is the window contract
// both sections already have. Pure functions over "YYYY-MM-DD" strings in UTC, unit-tested.

export type Granularity = "day" | "week" | "month" | "year" | "range";
export const GRANULARITIES: { key: Granularity; label: string }[] = [
  { key: "day", label: "Day" },
  { key: "week", label: "Week" },
  { key: "month", label: "Month" },
  { key: "year", label: "Year" },
  { key: "range", label: "Range" },
];

export const MONTHS_SHORT = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const utc = (iso: string) => new Date(iso + "T00:00:00Z");
const toIso = (d: Date) => d.toISOString().slice(0, 10);

/** Is this a "YYYY-MM-DD" string that names a real date? */
export function isIsoDay(s: string | null | undefined): s is string {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = utc(s);
  return Number.isFinite(d.getTime()) && toIso(d) === s;
}

export function addDays(iso: string, n: number): string {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return toIso(d);
}

/** The Sunday that starts the week holding `iso` (UTC). */
export function weekStart(iso: string): string {
  const d = utc(iso);
  d.setUTCDate(d.getUTCDate() - d.getUTCDay());
  return toIso(d);
}

/** Last day of the month holding `iso`. */
export function monthEnd(iso: string): string {
  const [y, m] = iso.slice(0, 7).split("-").map(Number);
  return `${iso.slice(0, 7)}-${String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, "0")}`;
}

/** "Aug 16" */
export function shortDay(iso: string): string {
  const d = utc(iso);
  return `${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCDate()}`;
}

/** The from→to window a pick compiles to. `a` is the picked anchor; `b` the second endpoint
 *  of a range (order-normalised, and a lone range endpoint is a one-day window). */
export function granularityWindow(g: Granularity, a: string, b: string | null = null): [string, string] {
  switch (g) {
    case "day": return [a, a];
    case "week": { const s = weekStart(a); return [s, addDays(s, 6)]; }
    case "month": return [`${a.slice(0, 7)}-01`, monthEnd(a)];
    case "year": return [`${a.slice(0, 4)}-01-01`, `${a.slice(0, 4)}-12-31`];
    case "range": return b && b < a ? [b, a] : [a, b ?? a];
  }
}

/** Every day of the month holding `iso`, in order. */
export function daysOfMonth(iso: string): string[] {
  const out: string[] = [];
  const last = monthEnd(iso);
  for (let d = `${iso.slice(0, 7)}-01`; d <= last; d = addDays(d, 1)) out.push(d);
  return out;
}

/** The week-start Sundays whose weeks touch the month holding `iso`, in order. */
export function weeksOfMonth(iso: string): string[] {
  const out: string[] = [];
  const last = monthEnd(iso);
  for (let w = weekStart(`${iso.slice(0, 7)}-01`); w <= last; w = addDays(w, 7)) out.push(w);
  return out;
}

/** Count run dates per key: day ("YYYY-MM-DD"), week (its Sunday), month ("YYYY-MM") or year. */
export function countRuns(dates: string[], by: "day" | "week" | "month" | "year"): Map<string, number> {
  const key = (d: string) => (by === "day" ? d : by === "week" ? weekStart(d) : by === "month" ? d.slice(0, 7) : d.slice(0, 4));
  const out = new Map<string, number>();
  for (const d of dates) {
    if (!isIsoDay(d)) continue;
    const k = key(d);
    out.set(k, (out.get(k) ?? 0) + 1);
  }
  return out;
}

/** Move a "YYYY-MM" view by n months. */
export function shiftMonth(view: string, n: number): string {
  const [y, m] = view.split("-").map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** The button caption for a window: "Aug 16 – Aug 22", or one day, or "lifetime" when open. */
export function windowCaption(from: string, to: string): string {
  if (!isIsoDay(from) && !isIsoDay(to)) return "All time";
  if (isIsoDay(from) && !isIsoDay(to)) return `${shortDay(from)} – today`;
  if (!isIsoDay(from) && isIsoDay(to)) return `up to ${shortDay(to)}`;
  return from === to ? shortDay(from) : `${shortDay(from)} – ${shortDay(to)}`;
}
