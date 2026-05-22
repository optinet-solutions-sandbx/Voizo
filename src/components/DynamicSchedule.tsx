"use client";

// P5: Live target-tz clock + countdown for the campaign detail page.
//
// Three states driven by status + start_at + end_at:
//   1. Scheduled future  →  "Starts in 1h 23m · 6:00 AM Sydney"
//   2. Running           →  "Running for 3h 20m · started 6:00 AM Sydney"
//   3. Completed         →  "Ran 6:00 AM – 11:30 AM Sydney (5h 30m)"
//
// The primary line is in the campaign's TARGET timezone (the customer-facing
// dial time, which is what operators care about). A muted sub-label shows
// the same instant in the operator's BROWSER timezone, but only when the
// two timezones differ — otherwise it's redundant noise.
//
// Updates every 1s via an internal setInterval so countdowns tick live.
// Cleaned up on unmount.

import { useEffect, useState } from "react";

interface Props {
  startAt: string | null | undefined;
  endAt: string | null | undefined;
  status: string;
  /** Campaign target timezone (IANA, e.g. "Australia/Sydney"). */
  timezone: string;
  /** Optional className for the outer wrapper. */
  className?: string;
}

function cityLabel(tz: string): string {
  // "Australia/Sydney" → "Sydney". "America/Toronto" → "Toronto".
  // "Etc/UTC" → "UTC". Falls back to the full tz string for short tokens.
  const last = tz.split("/").pop() ?? tz;
  return last.replace(/_/g, " ");
}

function formatTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function formatDateTime(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function browserTz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return "UTC";
  }
}

// Same calendar day in the target TZ? Used to decide whether to render
// just the time or include the date.
function sameDayInTz(a: Date, b: Date, tz: string): boolean {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  return f.format(a) === f.format(b);
}

function formatDuration(ms: number): string {
  if (ms < 0) ms = 0;
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes % (60 * 24)) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.floor(ms / 1000)}s`;
}

export default function DynamicSchedule({
  startAt,
  endAt,
  status,
  timezone,
  className,
}: Props) {
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!startAt) {
    return (
      <div className={className}>
        <span className="text-[var(--text-3)]">Not scheduled</span>
      </div>
    );
  }

  const start = new Date(startAt);
  const end = endAt ? new Date(endAt) : null;
  const tz = timezone || "UTC";
  const myTz = browserTz();
  const showSubLabel = tz !== myTz;

  const isFuture = start.getTime() > now.getTime();
  const isCompleted = status === "completed" || status === "archived";
  const isRunning = status === "running" && !isFuture;

  let primary: string;
  let secondary: string | null = null;

  if (isCompleted && end) {
    // Completed: "Ran 6:00 AM – 11:30 AM Sydney (5h 30m)"
    const dur = formatDuration(end.getTime() - start.getTime());
    const startTime = formatTime(start, tz);
    const endStr = sameDayInTz(start, end, tz)
      ? formatTime(end, tz)
      : formatDateTime(end, tz);
    primary = `Ran ${startTime} – ${endStr} ${cityLabel(tz)} (${dur})`;
    if (showSubLabel) {
      const myStart = formatTime(start, myTz);
      const myEnd = sameDayInTz(start, end, myTz)
        ? formatTime(end, myTz)
        : formatDateTime(end, myTz);
      secondary = `${myStart} – ${myEnd} your time`;
    }
  } else if (isRunning) {
    // Running: "Running for 3h 20m · started 6:00 AM Sydney"
    const dur = formatDuration(now.getTime() - start.getTime());
    primary = `Running for ${dur} · started ${formatTime(start, tz)} ${cityLabel(tz)}`;
    if (showSubLabel) {
      secondary = `started ${formatTime(start, myTz)} your time`;
    }
  } else if (isFuture) {
    // Scheduled future: "Starts in 1h 23m · 6:00 AM Sydney"
    const dur = formatDuration(start.getTime() - now.getTime());
    const sameDay = sameDayInTz(now, start, tz);
    const startStr = sameDay ? formatTime(start, tz) : formatDateTime(start, tz);
    primary = `Starts in ${dur} · ${startStr} ${cityLabel(tz)}`;
    if (showSubLabel) {
      const mySameDay = sameDayInTz(now, start, myTz);
      const myStr = mySameDay ? formatTime(start, myTz) : formatDateTime(start, myTz);
      secondary = `${myStr} your time`;
    }
  } else {
    // Past start but not running/completed (paused / inactive / draft with
    // past start_at). Show the original scheduled time as a reference.
    primary = `Was scheduled ${formatDateTime(start, tz)} ${cityLabel(tz)}`;
    if (showSubLabel) {
      secondary = `${formatDateTime(start, myTz)} your time`;
    }
  }

  return (
    <div className={className}>
      <div className="text-sm text-[var(--text-1)] tabular-nums">{primary}</div>
      {secondary && (
        <div className="text-xs text-[var(--text-3)] mt-0.5 tabular-nums">{secondary}</div>
      )}
    </div>
  );
}
