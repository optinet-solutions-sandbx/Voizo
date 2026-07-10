// Real-time campaign top-up (VOZ-132 — docs/2026-07-09_SPEC_RealTime_Campaigns_and_Operator_Controls.md).
//
// A real-time campaign is a recurring parent with campaigns_v2.realtime=true.
// Its daily children spawn EMPTY (recurringSpawn.ts realtime branch); this
// module is their only number source: every minute the realtime-poll cron
// diffs Customer.io segment membership against realtime_seen_members and
// admits new members through country + daily-cap checks.
//
// Pure decision logic first (unit-tested in realtimePoll.test.ts);
// I/O orchestration below.

// Relative imports (not "@/lib/..."): vitest has no alias config in this
// repo — tested lib modules must resolve without it.
import { COUNTRY_TO_TIMEZONES, detectCountry } from "../audienceCountry";
import { parsePhoneList } from "../campaignV2Shared";

// ── Pure decisions ────────────────────────────────────────────────────────

/**
 * Inverse of COUNTRY_TO_TIMEZONES. America/Toronto → "NA" (the +1 bucket —
 * a US number in a CA list is undetectable by prefix; known limit, same as
 * the wizard's audience guard). UTC/unknown → null = no country constraint.
 */
export function expectedCountryForTimezone(tz: string): string | null {
  if (tz === "UTC") return null; // the explicit "no constraint" zone
  for (const [country, zones] of Object.entries(COUNTRY_TO_TIMEZONES)) {
    if (zones.includes(tz)) return country;
  }
  return null;
}

export type Admission =
  | { admit: true; phone: string }
  | {
      admit: false;
      claimStatus: "rejected_country" | "no_phone" | "invalid_phone";
      phone: string | null;
    }
  | { admit: false; capBlocked: true };

/**
 * Admission decision for ONE new segment member (spec item 4 — boundary
 * checks at the door). Cap first: a capped day does no phone/country work
 * and claims nothing, so cap-blocked members retry on a later day. Country
 * and phone-shape failures ARE claimed (permanent for this member).
 */
export function decideAdmission(args: {
  rawPhone: string | null;
  expectedCountry: string | null;
  addedToday: number;
  dailyCap: number | null;
}): Admission {
  if (args.dailyCap != null && args.addedToday >= args.dailyCap) {
    return { admit: false, capBlocked: true };
  }
  if (args.rawPhone == null || args.rawPhone.trim() === "") {
    return { admit: false, claimStatus: "no_phone", phone: null };
  }
  const [phone] = parsePhoneList(args.rawPhone);
  if (!phone) return { admit: false, claimStatus: "invalid_phone", phone: null };
  if (args.expectedCountry != null && detectCountry(phone) !== args.expectedCountry) {
    return { admit: false, claimStatus: "rejected_country", phone };
  }
  return { admit: true, phone };
}

/** Unseen member ids, input order, deduped. */
export function diffNewMembers(memberIds: string[], seenIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const emitted = new Set<string>();
  for (const id of memberIds) {
    if (seenIds.has(id) || emitted.has(id)) continue;
    emitted.add(id);
    out.push(id);
  }
  return out;
}
