// src/lib/audienceCountry.ts
//
// Audience-country detection from E.164 phone prefixes — backbone of the
// wizard's timezone guardrail. Returns the dominant country code in a phone
// list iff ≥80% of detected phones agree.
//
// Hand-rolled prefix map (no libphonenumber-js). Only covers countries that
// have an entry in TIMEZONE_OPTIONS — if a country isn't dialable through
// Voizo, detection returning null is the right answer (no enforcement).
//
// See plan: C:\Users\jasin\.claude\plans\new-shift-picking-gentle-puffin.md

const MIN_SAMPLE_SIZE = 5;
const SAMPLE_LIMIT = 20;
const CONFIDENCE_THRESHOLD = 0.8;

// Prefix → country code map. Order doesn't matter — sorted longest-first
// in the IIFE below so the matcher resolves "+971" before "+1".
const PREFIX_TO_COUNTRY: Array<{ prefix: string; country: string }> = (() => {
  const raw: Array<{ prefix: string; country: string }> = [
    { prefix: "+971", country: "AE" }, // United Arab Emirates
    { prefix: "+61",  country: "AU" }, // Australia
    { prefix: "+49",  country: "DE" }, // Germany
    { prefix: "+34",  country: "ES" }, // Spain
    { prefix: "+33",  country: "FR" }, // France
    { prefix: "+30",  country: "GR" }, // Greece
    { prefix: "+81",  country: "JP" }, // Japan
    { prefix: "+52",  country: "MX" }, // Mexico
    { prefix: "+1",   country: "NA" }, // US + Canada share +1 (see COUNTRY_TO_TIMEZONES.NA)
    { prefix: "+63",  country: "PH" }, // Philippines
    { prefix: "+65",  country: "SG" }, // Singapore
    { prefix: "+44",  country: "UK" }, // United Kingdom
  ];
  return raw.sort((a, b) => b.prefix.length - a.prefix.length);
})();

/**
 * Country → allowed IANA timezones. Values MUST exist in TIMEZONE_OPTIONS
 * (wizardState.ts). NA is the special "+1" bucket: allows operator to pick
 * any US or CA timezone within +1 — we don't try to distinguish US-vs-CA
 * without area-code logic (see plan: out-of-scope).
 */
export const COUNTRY_TO_TIMEZONES: Record<string, string[]> = {
  AE: ["Asia/Dubai"],
  AU: ["Australia/Sydney"],
  DE: ["Europe/Berlin"],
  ES: ["Europe/Madrid"],
  FR: ["Europe/Paris"],
  GR: ["Europe/Athens"],
  JP: ["Asia/Tokyo"],
  MX: ["America/Mexico_City"],
  NA: [
    "America/Toronto",
    "America/Vancouver",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
  ],
  PH: ["Asia/Manila"],
  SG: ["Asia/Singapore"],
  UK: ["Europe/London"],
};

export const COUNTRY_LABELS: Record<string, string> = {
  AE: "United Arab Emirates",
  AU: "Australia",
  DE: "Germany",
  ES: "Spain",
  FR: "France",
  GR: "Greece",
  JP: "Japan",
  MX: "Mexico",
  NA: "North America (US/CA)",
  PH: "Philippines",
  SG: "Singapore",
  UK: "United Kingdom",
};

/** Single-phone country lookup (longest-prefix match). Returns null if no prefix matches. */
export function detectCountry(phone: string): string | null {
  for (const { prefix, country } of PREFIX_TO_COUNTRY) {
    if (phone.startsWith(prefix)) return country;
  }
  return null;
}

export interface DetectionResult {
  /** Country code (e.g. "AU", "NA") iff ≥80% of detected phones agree. */
  country: string | null;
  /** Share of the dominant country in the detected subset (0..1). */
  confidence: number;
  /** Number of phones that resolved to a known country code. */
  sampleSize: number;
}

/**
 * Sample up to 20 phones, count country codes, return the dominant one iff
 * it's ≥80% of detected phones. Below 5 phones total → null (avoids early-
 * typing thrash). All phones unmapped → null.
 */
export function detectAudienceCountry(phones: string[]): DetectionResult {
  const sample = phones.slice(0, SAMPLE_LIMIT);
  if (sample.length < MIN_SAMPLE_SIZE) {
    return { country: null, confidence: 0, sampleSize: sample.length };
  }
  const counts = new Map<string, number>();
  let detected = 0;
  for (const p of sample) {
    const c = detectCountry(p);
    if (c) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
      detected++;
    }
  }
  if (detected === 0) {
    return { country: null, confidence: 0, sampleSize: 0 };
  }
  let topCountry = "";
  let topCount = 0;
  for (const [country, count] of counts) {
    if (count > topCount) {
      topCount = count;
      topCountry = country;
    }
  }
  const confidence = topCount / detected;
  if (confidence < CONFIDENCE_THRESHOLD) {
    return { country: null, confidence, sampleSize: detected };
  }
  return { country: topCountry, confidence, sampleSize: detected };
}

export interface AudienceBreakdown {
  /** Per-country share, sorted descending. Only includes recognized prefixes. */
  byCountry: Array<{ country: string; count: number; share: number }>;
  /** Number of phones that resolved to a known country code. */
  sampleSize: number;
  /** True when no single country reaches the confidence threshold and at
   *  least 2 countries each have ≥15% share — i.e., genuinely mixed. */
  isMixed: boolean;
}

/**
 * M2: Returns the full per-country breakdown of an audience for the mixed-
 * country advisory. Pairs with detectAudienceCountry (which returns null in
 * the mixed case) so the wizard can decide between "appears to be X" copy
 * vs "spans X% / Y%" copy.
 *
 * Same sampling rules as detectAudienceCountry: up to 20 phones, requires
 * ≥5 in the sample, ignores unrecognized prefixes. `isMixed` is true when
 * no country reaches CONFIDENCE_THRESHOLD AND there are 2+ countries with
 * meaningful share — guards against the "noise" case where 19 AU + 1
 * unknown country shows up as 95%/5%.
 */
export function analyzeAudienceCountry(phones: string[]): AudienceBreakdown {
  const sample = phones.slice(0, SAMPLE_LIMIT);
  if (sample.length < MIN_SAMPLE_SIZE) {
    return { byCountry: [], sampleSize: 0, isMixed: false };
  }
  const counts = new Map<string, number>();
  let detected = 0;
  for (const p of sample) {
    const c = detectCountry(p);
    if (c) {
      counts.set(c, (counts.get(c) ?? 0) + 1);
      detected++;
    }
  }
  if (detected === 0) {
    return { byCountry: [], sampleSize: 0, isMixed: false };
  }
  const byCountry = Array.from(counts.entries())
    .map(([country, count]) => ({ country, count, share: count / detected }))
    .sort((a, b) => b.share - a.share);
  const top = byCountry[0];
  const meaningful = byCountry.filter((b) => b.share >= 0.15);
  const isMixed = top.share < CONFIDENCE_THRESHOLD && meaningful.length >= 2;
  return { byCountry, sampleSize: detected, isMixed };
}

/** Returns the allowed-TZ array for a country, or null if no constraint. */
export function allowedTimezonesForCountry(country: string | null): string[] | null {
  if (!country) return null;
  return COUNTRY_TO_TIMEZONES[country] ?? null;
}

/** First entry in the allowed-TZ array — used as the default when cascading. */
export function defaultTimezoneForCountry(country: string | null): string | null {
  if (!country) return null;
  return COUNTRY_TO_TIMEZONES[country]?.[0] ?? null;
}

/** True if `timezone` is in the country's allowed set (or no constraint applies). */
export function isTimezoneValidForCountry(country: string | null, timezone: string): boolean {
  if (!country) return true;
  const allowed = COUNTRY_TO_TIMEZONES[country];
  if (!allowed) return true;
  return allowed.includes(timezone);
}

/** Human-readable label for the country code, e.g. "AU" → "Australia". */
export function countryLabel(country: string | null): string {
  if (!country) return "";
  return COUNTRY_LABELS[country] ?? country;
}

/**
 * Wizard creation guard: a blocking error string when the detected audience
 * country has a constrained tz set that excludes `timezone`, UNLESS the operator
 * acknowledged THIS exact mismatch. Null (allow) when country is unknown/mixed/
 * small, the tz is valid, or the ack matches. Pure — no imports beyond this file.
 *
 * `ackFor` is the `${country}:${timezone}` key the operator ticked the override
 * for; storing the key (not a bare boolean) auto-invalidates the ack when the
 * timezone OR the detected country changes — no reducer reset needed.
 */
export function audienceTzGuard(
  parsedNumbers: string[],
  timezone: string,
  ackFor: string | null,
): string | null {
  const { country } = detectAudienceCountry(parsedNumbers);
  if (!country) return null;
  if (isTimezoneValidForCountry(country, timezone)) return null;
  if (ackFor === `${country}:${timezone}`) return null;
  const allowed = allowedTimezonesForCountry(country) ?? [];
  const label = countryLabel(country);
  return (
    `Audience looks like ${label} numbers, but the timezone is ${timezone}, which isn't a ${label} calling zone. ` +
    `Pick ${allowed.join(" / ")} — or tick the override below to dial ${label} on ${timezone} anyway.`
  );
}
