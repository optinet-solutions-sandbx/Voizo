// src/app/workers/timezone-coords.ts
//
// Maps a campaign's IANA timezone to display info + globe coordinates.
// 17-city anchor set inherited from the 2026-05-15 design session; identical
// city list to the prior workers/page.tsx but with real lat/lon (rather than
// the empirically-tuned x/y % used for the flat map). The globe uses these
// lat/lon directly via d3.geoOrthographic.
//
// If a leased campaign's timezone isn't in this table, the worker still
// renders in the side panel (with the raw timezone string) but no globe pin
// appears for it.

export interface TimezoneCoords {
  lat: number;
  lon: number;
  city: string;
  country: string;     // ISO-2
  short: string;       // 3-letter airport-style code
}

export const TIMEZONE_COORDS: Record<string, TimezoneCoords> = {
  "America/Vancouver":   { lat: 49.28,  lon: -123.12, city: "Vancouver",   country: "CA", short: "VAN" },
  "America/Los_Angeles": { lat: 34.05,  lon: -118.24, city: "Los Angeles", country: "US", short: "LAX" },
  "America/Denver":      { lat: 39.74,  lon: -104.99, city: "Denver",      country: "US", short: "DEN" },
  "America/Chicago":     { lat: 41.88,  lon: -87.63,  city: "Chicago",     country: "US", short: "CHI" },
  "America/Toronto":     { lat: 43.65,  lon: -79.38,  city: "Toronto",     country: "CA", short: "YYZ" },
  "America/New_York":    { lat: 40.71,  lon: -74.01,  city: "New York",    country: "US", short: "NYC" },
  "America/Mexico_City": { lat: 19.43,  lon: -99.13,  city: "Mexico City", country: "MX", short: "MEX" },
  "Europe/London":       { lat: 51.51,  lon: -0.13,   city: "London",      country: "UK", short: "LDN" },
  "Europe/Paris":        { lat: 48.86,  lon: 2.35,    city: "Paris",       country: "FR", short: "PAR" },
  "Europe/Berlin":       { lat: 52.52,  lon: 13.40,   city: "Berlin",      country: "DE", short: "BER" },
  "Europe/Madrid":       { lat: 40.42,  lon: -3.70,   city: "Madrid",      country: "ES", short: "MAD" },
  "Europe/Athens":       { lat: 37.97,  lon: 23.73,   city: "Athens",      country: "GR", short: "ATH" },
  "Asia/Dubai":          { lat: 25.20,  lon: 55.27,   city: "Dubai",       country: "AE", short: "DXB" },
  "Asia/Singapore":      { lat: 1.35,   lon: 103.82,  city: "Singapore",   country: "SG", short: "SIN" },
  "Asia/Manila":         { lat: 14.60,  lon: 120.98,  city: "Manila",      country: "PH", short: "MNL" },
  "Asia/Tokyo":          { lat: 35.68,  lon: 139.69,  city: "Tokyo",       country: "JP", short: "TYO" },
  "Australia/Sydney":    { lat: -33.87, lon: 151.21,  city: "Sydney",      country: "AU", short: "SYD" },
};

/** Resolve coords for a campaign timezone. Returns null if unknown. */
export function coordsForTimezone(tz: string | null | undefined): TimezoneCoords | null {
  if (!tz) return null;
  return TIMEZONE_COORDS[tz] ?? null;
}

/** Format the current UTC offset for a timezone (e.g. "UTC+8", "UTC-5:30"). */
export function formatUtcOffset(now: Date, tz: string): string {
  try {
    const parts = new Intl.DateTimeFormat(undefined, {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(now);
    const offset = parts.find(p => p.type === "timeZoneName")?.value ?? "";
    return offset.replace("GMT", "UTC");
  } catch {
    return "";
  }
}

/** Format hh:mm AM/PM in the given timezone. */
export function formatLocalTime(now: Date, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hour: "numeric", minute: "2-digit", hour12: true,
    }).format(now);
  } catch {
    return "--:--";
  }
}

/** "47s" / "12m" / "2h 14m" — for leased durations. */
export function formatLeasedDuration(ms: number | null): string {
  if (ms === null || ms < 0) return "—";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`;
  const hours = Math.floor(ms / 3_600_000);
  const mins  = Math.floor((ms % 3_600_000) / 60_000);
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
}

/** "00:00" / "03:33" — for live call elapsed. */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
