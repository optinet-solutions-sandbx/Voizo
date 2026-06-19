// Immutable toggle of a key in a Set — returns a NEW set so it's safe to use directly as React
// state (mutating the existing set wouldn't trigger a re-render). Used by the interactive chart
// legends (DailyVolumeChart, TrendChart) to show/hide a series.
export function toggleKey(set: Set<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}
