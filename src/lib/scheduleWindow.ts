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

/** "HH:MM" (24h) → minutes since midnight. Defensive parse (NaN → 0).
 *
 *  VOZ-365: this replaced a LEXICAL string compare, which was silently wrong for
 *  unpadded input. An operator-entered "9:00" made `"18:47" >= "9:00"` evaluate
 *  FALSE (because "1" < "9"), so the window never opened after 09:59 — with no
 *  error anywhere. Nothing validates zero-padding on write, so we parse instead
 *  of trusting the format. */
function hhmmToMinutes(hhmm: string): number {
  const [h, m] = String(hhmm ?? "").split(":");
  return (Number(h) || 0) * 60 + (Number(m) || 0);
}

/** True if `atMs` falls within ANY enabled call window for that weekday, evaluated
 *  in `timezone`. Empty or missing windows = NEVER open (VOZ-364: an unconfigured
 *  or malformed call_windows must mean "dial nothing", not "dial anytime" — the
 *  previous `return true` here was one of two fail-open compliance gates). The
 *  one sanctioned exception is Ghost Portal's test-tier launch, which now passes
 *  an explicit all-day window instead of `[]` (see launch/route.ts ALL_DAY_TEST_WINDOWS)
 *  rather than relying on this function defaulting open.
 *
 *  Boundary semantics (locked by tests): OPEN edge inclusive, CLOSE edge exclusive
 *  (`>= start`, `< end`) — aligned campaigns must never false-block. Because the
 *  close edge is exclusive and `nowMinutes` maxes at 1439 ("23:59"), an end of
 *  "23:59" is CLOSED for that final minute; a genuinely all-day window needs "24:00".
 *
 *  An unusable timezone also denies (see the catch below) — never throws to callers.
 *
 *  VOZ-360: this used `windows.find(w => w.day === weekday)`, which honoured only
 *  the FIRST window on a day and silently ignored the rest. A split window such as
 *  09:00–10:00 + 15:00–19:00 never dialled its afternoon band, with nothing logged.
 *  `.some()` evaluates every window for the day and also subsumes the old
 *  "no window for today → false" branch. A malformed window where start >= end
 *  simply never matches, which is the safe direction. */
export function isWithinCallWindowAt(windows: CallWindowLite[], timezone: string, atMs: number): boolean {
  if (!windows || windows.length === 0) return false;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(atMs));
  } catch {
    // An invalid-but-truthy tz ("Manila", "") makes Intl throw RangeError. Nothing
    // validates campaigns_v2.timezone on write (text not null, no CHECK) and ghost
    // launch forwards a client-supplied value, so this is reachable from user input.
    // Uncaught, it escapes into the scheduler's GET and 500s the ENTIRE tick every
    // minute — no spawns, no heartbeat, no last-resort sweep — and a draft row keeps
    // re-throwing forever because it never leaves the draft loop. That is precisely
    // the outage f174e9a fixed in the sibling TRUNK gate; this gate never got it.
    // Direction differs on purpose: the trunk gate fails OPEN by contract and returned
    // UNKNOWN; this gate fails CLOSED, so an unusable timezone must DENY. One bad row
    // must not be able to take the fleet down, and must not silently dial either.
    console.error(
      `[scheduleWindow] UNUSABLE timezone ${JSON.stringify(timezone)} — cannot evaluate the call ` +
        `window, DENYING the dial (fail-closed). Fix campaigns_v2.timezone to an IANA zone ` +
        `(e.g. "Australia/Sydney"); this row will never dial until it is corrected.`,
    );
    return false;
  }
  const weekday = parts.find((p) => p.type === "weekday")?.value?.toLowerCase().slice(0, 3) || "";
  let hour = parts.find((p) => p.type === "hour")?.value || "00";
  if (hour === "24") hour = "00"; // V8 hour12:false midnight edge
  const minute = parts.find((p) => p.type === "minute")?.value || "00";
  const nowMinutes = hhmmToMinutes(`${hour}:${minute}`);

  return windows.some(
    (w) =>
      w.day === weekday &&
      nowMinutes >= hhmmToMinutes(w.start) &&
      nowMinutes < hhmmToMinutes(w.end),
  );
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

/** Minutes between two "HH:MM" 24h times on the same day (end - start). Shares
 *  hhmmToMinutes with isWithinCallWindowAt so the two can never disagree on how a
 *  time is parsed (this file previously carried a private duplicate of that parser). */
function windowLengthMinutes(start: string, end: string): number {
  return hhmmToMinutes(end) - hhmmToMinutes(start);
}

/** Shortest enabled call-window length in minutes, or null when there are NO
 *  windows ("shortest" is undefined over an empty set). Malformed or non-positive
 *  windows are ignored.
 *
 *  ⚠️ VOZ-364: do NOT read this null as "no windows = always open" — that used to be
 *  this file's contract and it is now the OPPOSITE of it. isWithinCallWindowAt fails
 *  CLOSED on an empty window set (a compliance gate), so an empty set can never dial.
 *  The null here means only "undefined", and retryFitsShortestWindow below still maps
 *  it to `true`, which reads as "the retry fits" for a set that cannot dial at all.
 *  That is stale-but-inert today (its only caller gates on enabledRows.length > 0
 *  first — StepSchedule.tsx:413). Changing these return values touches the wizard's
 *  retry-fit logic and needs its own ticket; the comments are corrected here so
 *  nobody re-derives "empty = open" from the same file that now denies it. */
export function minWindowMinutes(windows: CallWindowLite[]): number | null {
  if (!windows || windows.length === 0) return null;
  let min = Infinity;
  for (const w of windows) {
    const len = windowLengthMinutes(w.start, w.end);
    if (Number.isFinite(len) && len > 0 && len < min) min = len;
  }
  return min === Infinity ? null : min;
}

/** True if a retry scheduled `retryMinutes` after a first attempt can still land
 *  INSIDE the shortest window — i.e. the shortest window is strictly longer than
 *  the retry gap. When false, a no-answer's retry is scheduled after the window
 *  closes and never dials that day; the create-time guard warns the operator.
 *
 *  ⚠️ VOZ-364: the `min == null` → `true` branch below is inherited from the old
 *  "no windows = always open = fits" contract, which no longer holds — an empty
 *  window set now DENIES every dial (isWithinCallWindowAt). So for an empty set this
 *  answers "the retry fits" about a campaign that cannot dial at all. Inert today
 *  (StepSchedule.tsx:413 gates on enabledRows.length > 0 before calling), left
 *  behaviourally unchanged on purpose — see minWindowMinutes above. */
export function retryFitsShortestWindow(windows: CallWindowLite[], retryMinutes: number): boolean {
  const min = minWindowMinutes(windows);
  if (min == null) return true;
  return min > retryMinutes;
}

/** Keep-awake predicate for realtime (always-on top-up) children — VOZ-183.
 *
 *  A realtime child with nothing to dial RIGHT NOW is its normal resting state
 *  (children spawn empty; the poll/webhook lanes top them up all day), so every
 *  "nothing left → completed" path must hold it open until its end_at passes.
 *  This guard existed inline in the scheduler's two sweeps but was missing from
 *  the chain-next webhook + operator-start route — the 2026-07-22 trial child
 *  was completed 31s after its only call ended, deafening the campaign for the
 *  rest of its day. Single source of truth so the four sites can't drift again.
 *
 *  Fail-closed: non-realtime, missing/invalid end_at, or end_at reached → false
 *  → the caller's existing completion behavior. `unknown` param types so raw
 *  supabase rows pass without casts; only `realtime === true` (real boolean
 *  from the column) holds the guard. */
export function shouldStayAwakeRealtime(
  campaign: { realtime?: unknown; end_at?: unknown },
  nowMs: number,
): boolean {
  if (campaign.realtime !== true) return false;
  if (typeof campaign.end_at !== "string" || campaign.end_at.length === 0) return false;
  return new Date(campaign.end_at).getTime() > nowMs; // NaN > n === false → malformed fails closed
}
