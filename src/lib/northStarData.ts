// src/lib/northStarData.ts
// Service-role reader for the North-Star metric. supabaseAdmin bypasses default-deny
// RLS; NEVER call from the client. PURE math lives in ./northStarMath. Selects ONLY
// non-PII columns (UUIDs + status enums + campaign name/is_test) — no phone, body,
// transcript, or message id reaches the wire.
import { supabaseAdmin } from "./supabaseServer";
import { fetchAllRowsParallel } from "./supabaseFetchAll";
import {
  computeNorthStar,
  excludeGhostRows,
  type NorthStarResult,
  type NsCallRow,
  type NsSmsRow,
  type NsCampaignRow,
} from "./northStarMath";

export async function readNorthStar(): Promise<NorthStarResult> {
  // fetchAllRowsParallel (2026-08-05): the sequential full-table calls_v2 read was
  // ~52 serial hops = the route's measured 35.4s on prod. THROWS on a failed read
  // (route 500s) instead of the old silent prefix-partial — for a metric, loud
  // beats presenting truncated totals as fact (same rationale as agentPerfData M3).
  const [calls, sms, campaigns] = await Promise.all([
    fetchAllRowsParallel(supabaseAdmin, "calls_v2", "id, campaign_id, goal_reached"),
    fetchAllRowsParallel(supabaseAdmin, "sms_messages_v2", "call_id, status"),
    fetchAllRowsParallel(supabaseAdmin, "campaigns_v2", "id, name, is_test, source"),
  ]);
  // Segregation: GhostPortal runs never reach this client-facing metric — and
  // is_test alone can't catch a live-tier ghost run (is_test=false there).
  return computeNorthStar(
    excludeGhostRows({
      calls: calls as unknown as NsCallRow[],
      sms: sms as unknown as NsSmsRow[],
      campaigns: campaigns as unknown as NsCampaignRow[],
    }),
  );
}
