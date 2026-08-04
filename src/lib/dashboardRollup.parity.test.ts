// dashboardRollup.parity.test.ts — LIVE-DB byte-parity gate for the SQL rollup
// cutover (VOZ-283, plan Task 2 Step 2). Fetches the raw rows exactly as
// /api/dashboard/campaigns does today, runs the REAL computeCampaignTable,
// then assembles the same rows from the dashboard_call_rollup /
// dashboard_sms_rollup RPCs via computeCampaignTableFromRollup — and requires
// every numeric field to be identical for every campaign.
//
// Both paths are bounded to created_at < asOf (taken up front) so live dialing
// can't race the two snapshots. Any mismatch is a DEFINITION bug: fix the SQL
// or the assembler to match the JS — never the other way (Val: "be true to
// our numbers").
import { describe, expect, it } from "vitest";
import * as fs from "fs";
import { createClient } from "@supabase/supabase-js";
import {
  buildCandidateDelta,
  computeCampaignTable,
  computeCampaignTableFromRollup,
  computeToday,
  computeTodayFromRollup,
  FINISHED_IDLE_DAYS,
  type CallRollupRow,
  type DashCallRow,
  type DashCampaignRow,
  type DashNumberRow,
  type DashSmsRow,
  type SmsRollupRow,
} from "./dashboardAnalytics";
import { substantiveUserTurnCount } from "./transcriptClassify";

const env: Record<string, string> = {};
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("=");
  if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Keyset-paginated full fetch (PostgREST clamps at 1000). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- PostgREST builder passthrough; test harness only
async function pageAll<T>(table: string, select: string, filter?: (q: any) => any): Promise<T[]> {
  const out: T[] = [];
  let lastId = "00000000-0000-0000-0000-000000000000";
  for (;;) {
    let q = svc.from(table).select(select).order("id", { ascending: true }).gt("id", lastId).limit(1000);
    if (filter) q = filter(q);
    const { data, error } = await q;
    if (error) throw new Error(`${table}: ${error.message}`);
    // Dynamic select strings defeat supabase-js row inference (GenericStringError)
    // — route rows through unknown; T is asserted by each call site.
    out.push(...(data as unknown as T[]));
    if (!data || data.length < 1000) return out;
    lastId = (data[data.length - 1] as unknown as { id: string }).id;
  }
}

describe("dashboard rollup parity — campaigns table (VOZ-283)", () => {
  it(
    "computeCampaignTableFromRollup === computeCampaignTable on live prod data",
    { timeout: 300_000 },
    async () => {
      const asOf = new Date().toISOString();
      const nowMs = Date.parse(asOf);

      // ── OLD path: raw rows, exactly the selects campaigns/route.ts makes ──
      const [calls, campaignsRes, numbers, sms] = await Promise.all([
        pageAll<DashCallRow>(
          "calls_v2",
          "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds",
          (q) => q.lt("created_at", asOf),
        ),
        svc
          .from("campaigns_v2")
          .select(
            "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at",
          ),
        pageAll<{ campaign_id: string; id: string; outcome: string | null }>(
          "campaign_numbers_v2",
          "campaign_id, id, outcome",
        ),
        pageAll<DashSmsRow & { id: string }>(
          "sms_messages_v2",
          "id, campaign_id, created_at, status, call_id, campaign_number_id",
          (q) => q.lt("created_at", asOf),
        ),
      ]);
      if (campaignsRes.error) throw new Error(campaignsRes.error.message);
      const campaigns = (campaignsRes.data ?? []) as unknown as DashCampaignRow[];

      const oldRows = computeCampaignTable(
        calls,
        campaigns,
        nowMs,
        FINISHED_IDLE_DAYS,
        numbers,
        sms as unknown as DashSmsRow[],
      );

      // ── NEW path: the two rollup RPCs + roster counts ──
      const [callRollupRes, smsRollupRes] = await Promise.all([
        svc.rpc("dashboard_call_rollup", { p_start: new Date(0).toISOString(), p_end: asOf }),
        svc.rpc("dashboard_sms_rollup", { p_start: new Date(0).toISOString(), p_end: asOf }),
      ]);
      if (callRollupRes.error) throw new Error(`call rollup: ${callRollupRes.error.message}`);
      if (smsRollupRes.error) throw new Error(`sms rollup: ${smsRollupRes.error.message}`);

      const playersByCampaign = new Map<string, number>();
      for (const n of numbers) {
        playersByCampaign.set(n.campaign_id, (playersByCampaign.get(n.campaign_id) ?? 0) + 1);
      }

      const newRows = computeCampaignTableFromRollup(
        callRollupRes.data as CallRollupRow[],
        smsRollupRes.data as SmsRollupRow[],
        campaigns,
        nowMs,
        FINISHED_IDLE_DAYS,
        playersByCampaign,
      );

      // ── Byte-parity on every numeric/derived field, per campaign ──
      expect(newRows.length).toBe(oldRows.length);
      const newById = new Map(newRows.map((r) => [r.id, r]));
      const mismatches: string[] = [];
      for (const o of oldRows) {
        const n = newById.get(o.id);
        if (!n) {
          mismatches.push(`${o.name}: missing from rollup path`);
          continue;
        }
        const fields: Array<keyof typeof o> = [
          "calls", "connected", "terminal", "successful", "connectRate", "successRate",
          "players", "reach", "smsSent", "displayStatus", "lastCallAt",
        ];
        for (const f of fields) {
          if (JSON.stringify(o[f]) !== JSON.stringify(n[f])) {
            mismatches.push(`${o.name} .${String(f)}: old=${JSON.stringify(o[f])} new=${JSON.stringify(n[f])}`);
          }
        }
        if (JSON.stringify(o.perf) !== JSON.stringify(n.perf)) {
          mismatches.push(`${o.name} .perf differs:\n  old=${JSON.stringify(o.perf)}\n  new=${JSON.stringify(n.perf)}`);
        }
      }
      if (mismatches.length > 0) {
        // Print every mismatch — the whole point of this gate.
        console.error(`PARITY MISMATCHES (${mismatches.length}):\n` + mismatches.slice(0, 20).join("\n"));
      }
      expect(mismatches).toEqual([]);
    },
  );

  it(
    "computeTodayFromRollup === computeToday on live prod data",
    { timeout: 300_000 },
    async () => {
      const MS_PER_DAY = 86_400_000;
      const asOf = new Date().toISOString();
      const nowMs = Date.parse(asOf);
      const cutoff = new Date(nowMs - 10 * MS_PER_DAY).toISOString();
      const todayStartMs = Date.UTC(
        new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate(),
      );

      // ── OLD path: raw rows exactly as today/route.ts fetches them ──
      const [calls, campaignsRes, allNumbers, sms] = await Promise.all([
        pageAll<DashCallRow>(
          "calls_v2",
          "id, campaign_id, campaign_number_id, status, goal_reached, created_at, voicemail, ended_reason, duration_seconds, transcript",
          (q) => q.gte("created_at", cutoff).lt("created_at", asOf),
        ),
        svc
          .from("campaigns_v2")
          .select(
            "id, name, status, source, is_test, campaign_type, voice_id, vapi_assistant_name, base_assistant_id, cio_workspace, start_at, created_at, end_at",
          ),
        pageAll<{ campaign_id: string; id: string; phone_e164: string | null; outcome: string | null }>(
          "campaign_numbers_v2",
          "campaign_id, id, phone_e164, outcome",
        ),
        pageAll<DashSmsRow & { id: string }>(
          "sms_messages_v2",
          "id, campaign_id, created_at, status, call_id, campaign_number_id",
          (q) => q.gte("created_at", cutoff).lt("created_at", asOf),
        ),
      ]);
      if (campaignsRes.error) throw new Error(campaignsRes.error.message);
      const campaigns = (campaignsRes.data ?? []) as unknown as DashCampaignRow[];

      // Old route scopes `numbers` to contacts referenced by the windowed calls.
      const refIds = new Set(calls.map((c) => c.campaign_number_id).filter(Boolean));
      const numbers = allNumbers.filter((n) => refIds.has(n.id)) as unknown as DashNumberRow[];
      const rosterByCampaign = new Map<string, number>();
      const runningIds = new Set(
        campaigns.filter((c) => c.source !== "ghost_portal" && c.is_test !== true && c.status === "running").map((c) => c.id),
      );
      for (const n of allNumbers) {
        if (runningIds.has(n.campaign_id)) {
          rosterByCampaign.set(n.campaign_id, (rosterByCampaign.get(n.campaign_id) ?? 0) + 1);
        }
      }

      const snapOld = computeToday(calls, campaigns, sms as unknown as DashSmsRow[], nowMs, numbers, rosterByCampaign);

      // ── NEW path: rollups + candidate delta ──
      const [callRollupRes, smsRollupRes] = await Promise.all([
        svc.rpc("dashboard_call_rollup", { p_start: cutoff, p_end: asOf }),
        svc.rpc("dashboard_sms_rollup", { p_start: cutoff, p_end: asOf }),
      ]);
      if (callRollupRes.error) throw new Error(`call rollup: ${callRollupRes.error.message}`);
      if (smsRollupRes.error) throw new Error(`sms rollup: ${smsRollupRes.error.message}`);

      // Candidate predicate — MUST stay in lockstep with today/route.ts's SQL.
      const campIndex = new Map(campaigns.map((c) => [c.id, c]));
      const declinedIds = new Set(numbers.filter((n) => (n.outcome ?? "") === "declined_offer").map((n) => n.id));
      const candidates = calls.filter((c) => {
        const camp = campIndex.get(c.campaign_id);
        if (!camp || camp.source === "ghost_portal" || camp.is_test === true) return false;
        // CONNECTED_STATUSES (locked): completed | answered.
        if (c.status !== "completed" && c.status !== "answered") return false;
        if (c.voicemail === true) return false;
        if (c.goal_reached === true) return false;
        if (c.ended_reason !== "customer-ended-call") return false;
        if (typeof c.duration_seconds === "number" && c.duration_seconds < 15) return false;
        if (c.campaign_number_id && declinedIds.has(c.campaign_number_id)) return false;
        return true;
      });
      const candidateIds = new Set(candidates.map((c) => c.id));
      const smsAttachments = (sms as unknown as DashSmsRow[]).filter(
        (m) => (m.status === "sent" || m.status === "delivered") && m.call_id && candidateIds.has(m.call_id),
      );
      const delta = buildCandidateDelta(candidates, smsAttachments, todayStartMs, substantiveUserTurnCount);

      const snapNew = computeTodayFromRollup(
        callRollupRes.data as CallRollupRow[],
        smsRollupRes.data as SmsRollupRow[],
        campaigns,
        nowMs,
        delta,
        rosterByCampaign,
      );

      const mismatches: string[] = [];
      const cmp = (label: string, a: unknown, b: unknown) => {
        if (JSON.stringify(a) !== JSON.stringify(b)) {
          mismatches.push(`${label}:\n  old=${JSON.stringify(a)}\n  new=${JSON.stringify(b)}`);
        }
      };
      cmp("dayUtc", snapOld.dayUtc, snapNew.dayUtc);
      cmp("ops", snapOld.ops, snapNew.ops);
      cmp("today", snapOld.today, snapNew.today);
      cmp("yesterday", snapOld.yesterday, snapNew.yesterday);
      cmp("runningCampaigns.length", snapOld.runningCampaigns.length, snapNew.runningCampaigns.length);
      for (let i = 0; i < snapOld.runningCampaigns.length; i++) {
        const o = snapOld.runningCampaigns[i];
        const n = snapNew.runningCampaigns[i];
        cmp(`runningCampaigns[${o?.name}]`, o, n);
      }
      if (mismatches.length > 0) {
        console.error(`TODAY PARITY MISMATCHES (${mismatches.length}):\n` + mismatches.slice(0, 10).join("\n"));
      }
      expect(mismatches).toEqual([]);
    },
  );
});
