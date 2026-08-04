// src/app/api/campaigns-v2/estimate-rates/route.ts
//
// Behavior rates for the campaign cost estimator (spec 2026-08-04 §5).
// Hierarchical resolution: lineage → country → global; first level with
// >= MIN_SAMPLE_DIALS wins (global always answers if it has any data).
// Heavy lifting is in the estimate_rates_v1 RPC — see the DDL header for
// why this MUST NOT be a select+reduce (1000-row clamp).
// Auth: not in middleware PUBLIC_PATH_PREFIXES → behind dashboard basic auth.

import { NextRequest, NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabaseServer";
import { allowedTimezonesForCountry } from "@/lib/audienceCountry";
import { PRICE_RATES } from "@/lib/costRates";
import type { BehaviorRates, RatesProvenance } from "@/lib/campaignEstimate";

const MIN_SAMPLE_DIALS = 300;

type Level = "lineage" | "country" | "global";

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const country = url.searchParams.get("country");
  const lineage = url.searchParams.get("lineage");

  const attempts: Array<{ level: Level; args: { p_parent_id: string | null; p_timezones: string[] | null } }> = [];
  if (lineage) attempts.push({ level: "lineage", args: { p_parent_id: lineage, p_timezones: null } });
  const tzs = country ? allowedTimezonesForCountry(country) : null;
  if (tzs && tzs.length > 0) attempts.push({ level: "country", args: { p_parent_id: null, p_timezones: tzs } });
  attempts.push({ level: "global", args: { p_parent_id: null, p_timezones: null } });

  const levelSamples: Partial<Record<Level, number>> = {};
  for (const a of attempts) {
    const { data, error } = await supabaseAdmin.rpc("estimate_rates_v1", a.args);
    if (error) {
      // Loud (house rule): a broken RPC must never render as silent zeros.
      console.error(`[estimate-rates] RPC failed at level=${a.level}:`, error.message);
      return NextResponse.json({ error: "rates computation failed" }, { status: 500 });
    }
    const sample = Number(data?.sampleDials ?? 0);
    levelSamples[a.level] = sample;
    const isLast = a.level === "global";
    if (sample >= MIN_SAMPLE_DIALS || (isLast && sample > 0)) {
      const provenance: RatesProvenance = {
        windowFrom: data.windowFrom ?? null,
        windowTo: data.windowTo ?? null,
        excludedDays: (data.excludedDays ?? []) as string[],
        level: a.level,
        levelSamples,
        sampleDials: sample,
        samplePlayers: Number(data.samplePlayers ?? 0),
        computedAt: data.computedAt,
      };
      const behavior: BehaviorRates = {
        p: Number(data.p ?? 0),
        rConnect: Number(data.rConnect ?? 0),
        tTalkSec: Number(data.tTalkSec ?? 0),
        tTalkHumanSec: data.tTalkHumanSec === null ? null : Number(data.tTalkHumanSec),
        tTalkVoicemailSec: data.tTalkVoicemailSec === null ? null : Number(data.tTalkVoicemailSec),
        voicemailShare: data.voicemailShare === null ? null : Number(data.voicemailShare),
        dialsPerHourP25: Number(data.dialsPerHourP25 ?? 0),
        dialsPerHourP50: Number(data.dialsPerHourP50 ?? 0),
        dialsPerHourP75: Number(data.dialsPerHourP75 ?? 0),
        provenance,
      };
      return NextResponse.json(
        { behavior, prices: PRICE_RATES },
        { headers: { "Cache-Control": "s-maxage=3600, stale-while-revalidate=86400" } },
      );
    }
  }
  console.error("[estimate-rates] no usable sample at any level:", JSON.stringify(levelSamples));
  return NextResponse.json({ error: "no historical data to estimate from", levelSamples }, { status: 503 });
}
