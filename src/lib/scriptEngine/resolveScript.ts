// Pure decision for VOZ-158 script resolution (spec:
// docs/superpowers/specs/2026-07-14-script-resolution-hardening-design.md).
// Given the campaigns_v2 rows holding a clone's vapi_assistant_id, decide
// whether the call's script identity is unambiguous. Dedup by script_id, NOT
// by row: recurring children sharing one script must not read as ambiguous.
// A wrong seed is permanent for the call (the route's leg 0 returns early on
// any seeded row), so ambiguity falls through to the exact vapi_call_id key
// instead of guessing newest.

export interface CampaignScriptRow {
  id: string;
  script_id: string | null;
  agent_mode: string | null;
}

export type ScriptSeedDecision =
  | { kind: "seed"; scriptId: string; campaignId: string }
  | { kind: "ambiguous"; scriptIds: string[]; campaignIds: string[] }
  | { kind: "none" };

export function decideScriptSeed(rows: CampaignScriptRow[]): ScriptSeedDecision {
  const scriptRows = rows.filter((r) => r.agent_mode === "script" && r.script_id);
  const distinct = [...new Set(scriptRows.map((r) => r.script_id as string))];
  if (distinct.length === 1) {
    return { kind: "seed", scriptId: distinct[0], campaignId: scriptRows[0].id };
  }
  if (distinct.length > 1) {
    return {
      kind: "ambiguous",
      scriptIds: distinct,
      campaignIds: scriptRows.map((r) => r.id),
    };
  }
  return { kind: "none" };
}
