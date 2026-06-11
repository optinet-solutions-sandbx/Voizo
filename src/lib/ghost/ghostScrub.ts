import type { SupabaseClient } from "@supabase/supabase-js";
import { dncSuppressedSet } from "../dncScrub";
import { CONTACT_OUTCOMES } from "../contactOutcomes";

// The single source of truth for turning a GhostPortal upload into a dial-eligible
// net list. Used by BOTH the scrub route (preview counts) and the launch route
// (re-scrub server-side, never trust the client). Compliance gate:
//   • DNC/suppression — NON-NEGOTIABLE, applied in BOTH tiers (via dncSuppressedSet).
//   • Recency — live tier only (test relaxes it). Mirrors the audience route's
//     N-day recency scrub (campaign_numbers_v2.last_attempted_at > cutoff). The
//     dialer is NOT imported — call-path discipline (CLAUDE.md non-negotiable #4).
// A phone on the DNC list can NEVER reach `net`, regardless of tier or recency.

export interface GhostScrubResult {
  uploaded: number;        // unique input phones
  suppressed: number;      // uploaded - net.length (removed by DNC and/or recency)
  net: string[];           // phones cleared to dial
  suppressedDnc: number;   // removed by DNC/suppression
  suppressedRecent: number; // removed by recency only (not already DNC)
}

export interface GhostScrubOptions {
  applyRecency: boolean;
  recentWindowDays?: number; // default 7 when applyRecency
}

export async function scrubGhostPhones(
  supabase: SupabaseClient,
  phones: string[],
  opts: GhostScrubOptions,
): Promise<GhostScrubResult> {
  const unique = Array.from(new Set(phones));
  const uploaded = unique.length;
  if (uploaded === 0) {
    return { uploaded: 0, suppressed: 0, net: [], suppressedDnc: 0, suppressedRecent: 0 };
  }

  // DNC — always, both tiers.
  const dncSet = await dncSuppressedSet(supabase, unique);

  // Recency — live only.
  const recentSet = new Set<string>();
  if (opts.applyRecency) {
    const days = opts.recentWindowDays && opts.recentWindowDays > 0 ? opts.recentWindowDays : 7;
    const cutoffIso = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("campaign_numbers_v2")
      .select("phone_e164")
      .in("phone_e164", unique)
      .in("outcome", CONTACT_OUTCOMES)
      .gt("last_attempted_at", cutoffIso);
    if (error) throw new Error(`ghost recency scrub failed: ${error.message}`);
    for (const r of data ?? []) recentSet.add(r.phone_e164 as string);
  }

  const net: string[] = [];
  let suppressedDnc = 0;
  let suppressedRecent = 0;
  for (const p of unique) {
    if (dncSet.has(p)) {
      suppressedDnc++;
      continue;
    }
    if (recentSet.has(p)) {
      suppressedRecent++;
      continue;
    }
    net.push(p);
  }

  return {
    uploaded,
    suppressed: uploaded - net.length,
    net,
    suppressedDnc,
    suppressedRecent,
  };
}
