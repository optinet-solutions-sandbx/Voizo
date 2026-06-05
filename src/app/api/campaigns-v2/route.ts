import { NextRequest, NextResponse } from "next/server";
import { rejectIfCrossOriginStrict } from "@/lib/csrf";
import { createCampaignV2, fetchCampaignsV2 } from "@/lib/campaignV2Data";
import type { CampaignV2CreateInput } from "@/lib/campaignV2Shared";

/**
 * /api/campaigns-v2  (collection)
 *
 * RLS Phase A (docs/2026-06-04_SPEC_RLS_Anon_PII_Lockdown.md). Both handlers run
 * SERVER-SIDE via the service role (campaignV2Data → supabaseAdmin), replacing
 * the browser's anon-key reads/writes of campaigns_v2. Auth-gated: not in
 * middleware's PUBLIC_PATH_PREFIXES, so it sits behind the dashboard Basic Auth.
 *
 * GET  → list all campaigns (full rows, newest-first) — replaces fetchCampaignsV2.
 * POST → create a campaign — replaces createCampaignV2. The Vapi clone (Fixed
 *        campaigns) is created by the wizard before this call; the input carries
 *        the clone ids. linkSlot + sipPool now run with the service role here.
 *
 * No strict origin check on GET (browsers omit Origin on same-origin GETs — see
 * memory csrf-origin-check-get-lenient); POST uses rejectIfCrossOriginStrict.
 */
export async function GET() {
  try {
    const campaigns = await fetchCampaignsV2();
    return NextResponse.json({ campaigns });
  } catch (err) {
    console.error("[campaigns-v2] list read failed:", err);
    return NextResponse.json({ error: "Failed to load campaigns" }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const csrf = rejectIfCrossOriginStrict(request);
  if (csrf) return csrf;

  let input: CampaignV2CreateInput;
  try {
    input = (await request.json()) as CampaignV2CreateInput;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Edge-of-API validation. The wizard's validateBeforeSubmit already enforces
  // the rich rules; this only rejects structurally-broken payloads so a bad
  // request can't reach the DB insert. `numbers` MAY be empty (recurring parents
  // are created without numbers; children get them on spawn).
  if (!input || typeof input.name !== "string" || !input.name.trim()) {
    return NextResponse.json({ error: "Campaign name is required" }, { status: 400 });
  }
  if (typeof input.systemPrompt !== "string") {
    return NextResponse.json({ error: "systemPrompt is required" }, { status: 400 });
  }
  if (!Array.isArray(input.numbers)) {
    return NextResponse.json({ error: "numbers must be an array" }, { status: 400 });
  }
  if (!Array.isArray(input.callWindows)) {
    return NextResponse.json({ error: "callWindows must be an array" }, { status: 400 });
  }

  try {
    const result = await createCampaignV2(input);
    console.log(`[campaigns-v2] created: campaign=${result.campaign?.id} numbers=${result.numberCount}`);
    return NextResponse.json(result);
  } catch (err) {
    console.error("[campaigns-v2] create failed:", err);
    const message = err instanceof Error ? err.message : "Failed to create campaign";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
