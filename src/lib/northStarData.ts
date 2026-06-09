// src/lib/northStarData.ts
// Service-role reader for the North-Star metric. supabaseAdmin bypasses default-deny
// RLS; NEVER call from the client. PURE math lives in ./northStarMath. Selects ONLY
// non-PII columns (UUIDs + status enums + campaign name/is_test) — no phone, body,
// transcript, or message id reaches the wire.
import { supabaseAdmin } from "./supabaseServer";
import { fetchAllRows } from "./supabaseFetchAll";
import {
  computeNorthStar,
  type NorthStarResult,
  type NsCallRow,
  type NsSmsRow,
  type NsCampaignRow,
} from "./northStarMath";

export async function readNorthStar(): Promise<NorthStarResult> {
  const [calls, sms, campaigns] = await Promise.all([
    fetchAllRows(supabaseAdmin, "calls_v2", "id, campaign_id, goal_reached"),
    fetchAllRows(supabaseAdmin, "sms_messages_v2", "call_id, status"),
    fetchAllRows(supabaseAdmin, "campaigns_v2", "id, name, is_test"),
  ]);
  return computeNorthStar({
    calls: calls as unknown as NsCallRow[],
    sms: sms as unknown as NsSmsRow[],
    campaigns: campaigns as unknown as NsCampaignRow[],
  });
}
