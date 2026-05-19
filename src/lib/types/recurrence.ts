export type DayOfWeek = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

export type RecurrenceEndKind = "never" | "on_date" | "after_n";

export interface RecurrencePattern {
  start_date: string;
  end_kind: RecurrenceEndKind;
  end_date: string | null;
  end_after_n: number | null;
  repeat_every_weeks: number;
  days_of_week: DayOfWeek[];
  call_hours_by_day: Partial<Record<DayOfWeek, { start: string; end: string }>>;
  exception_dates: string[];
  skip_if_empty: boolean;
  segment_refresh_time: string;
  last_spawn_date?: string | null;
  spawned_count?: number;
}

export interface RecurrenceValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateRecurrencePattern(p: RecurrencePattern): RecurrenceValidationResult {
  const errors: string[] = [];

  if (!p.start_date || !/^\d{4}-\d{2}-\d{2}$/.test(p.start_date)) {
    errors.push("Start date is required (YYYY-MM-DD).");
  }
  if (!Array.isArray(p.days_of_week) || p.days_of_week.length === 0) {
    errors.push("Pick at least one day of the week.");
  }
  if (!p.segment_refresh_time || !/^\d{2}:\d{2}$/.test(p.segment_refresh_time)) {
    errors.push("Segment refresh time is required (HH:MM).");
  }

  if (p.end_kind === "on_date" && !p.end_date) {
    errors.push("End date is required when 'End on' is selected.");
  }
  if (p.end_kind === "after_n" && (!p.end_after_n || p.end_after_n < 1)) {
    errors.push("End-after-N must be at least 1 when 'End after N occurrences' is selected.");
  }

  for (const day of p.days_of_week) {
    const hrs = p.call_hours_by_day[day];
    if (!hrs || !hrs.start || !hrs.end) {
      errors.push(`Call hours missing for ${day.toUpperCase()}.`);
      continue;
    }
    if (hrs.start >= hrs.end) {
      errors.push(`${day.toUpperCase()} start time must be before end time.`);
    }
  }

  if (p.repeat_every_weeks < 1) {
    errors.push("Repeat-every-weeks must be at least 1.");
  }

  return { ok: errors.length === 0, errors };
}
