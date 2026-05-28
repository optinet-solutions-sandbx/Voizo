/**
 * Returns the 3-letter lowercase day-of-week ("sun"..."sat") for a given
 * date evaluated in a target timezone.
 *
 * Mirrors the inline derivation pattern used by isWithinCallWindow
 * (src/lib/dialer.ts) and todayDowInTz (src/lib/scheduler/recurringSpawn.ts);
 * extracted so the new-campaign wizard can pre-flight the operator's
 * day-toggle vs start_at selection before persisting. See
 * [[project_campaign_day_window_mismatch]] for why this guardrail exists.
 */
export function dayOfWeekInTimezone(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: timezone })
    .format(date)
    .toLowerCase()
    .slice(0, 3);
}
