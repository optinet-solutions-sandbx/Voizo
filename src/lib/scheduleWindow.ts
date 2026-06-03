// src/lib/scheduleWindow.ts
//
// Pure, dependency-free call-window helpers for the Campaign V2 create wizard.
// isWithinCallWindowAt mirrors src/lib/dialer.ts:17-43 (isWithinCallWindow) but is
// parameterized on an explicit instant so it runs client-side for the "Immediately"
// notice. dialer.ts is the runtime source of truth and is left untouched (call-path
// file); this is a deliberate, documented ~15-line mirror. One intentional delta:
// it normalizes the V8 hour12:false "24" midnight edge to "00" (dialer.ts omits
// this) — affects only the display copy at exactly midnight, never a dial decision.

export interface CallWindowLite {
  day: string; // 3-letter lowercase, e.g. "mon"
  start: string; // "HH:MM" 24h
  end: string; // "HH:MM" 24h
}

/** True if `atMs` falls within an enabled call window, evaluated in `timezone`.
 *  Empty windows = always open (matches dialer.ts). */
export function isWithinCallWindowAt(windows: CallWindowLite[], timezone: string, atMs: number): boolean {
  if (!windows || windows.length === 0) return true;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase().slice(0, 3) || "";
  let hour = parts.find((p) => p.type === "hour")?.value || "00";
  if (hour === "24") hour = "00"; // V8 hour12:false midnight edge
  const minute = parts.find((p) => p.type === "minute")?.value || "00";
  const currentTime = `${hour}:${minute}`;
  const today = windows.find((w) => w.day === weekday);
  if (!today) return false;
  return currentTime >= today.start && currentTime < today.end;
}

export type StartMode = "now" | "delay" | "scheduled";

/** campaigns_v2.start_at from the wizard's start controls.
 *  "now" → nowMs (auto-fire; the cron's window-gate handles holding until open). */
export function resolveStartAt(
  startMode: StartMode,
  delayMinutes: number,
  scheduledDate: string,
  nowMs: number,
): string | null {
  if (startMode === "now") return new Date(nowMs).toISOString();
  if (startMode === "delay") return new Date(nowMs + delayMinutes * 60_000).toISOString();
  if (startMode === "scheduled" && scheduledDate) return new Date(scheduledDate).toISOString();
  return null;
}

/** "HH:MM" (24h) of `atMs` rendered in `timezone`. Same V8 "24"→"00" midnight
 *  normalization as isWithinCallWindowAt. Used for human-readable out-of-window copy. */
export function clockHHMMInTimezone(atMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(new Date(atMs));
  let hour = parts.find((p) => p.type === "hour")?.value || "00";
  if (hour === "24") hour = "00";
  const minute = parts.find((p) => p.type === "minute")?.value || "00";
  return `${hour}:${minute}`;
}
