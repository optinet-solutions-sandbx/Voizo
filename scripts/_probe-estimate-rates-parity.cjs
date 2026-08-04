/* scripts/_probe-estimate-rates-parity.cjs — READ-ONLY.
 * Ground-truths estimate_rates_v1 (global level) against a keyset-paginated JS
 * recompute of sampleDials / rConnect / tTalkSec over the same window+filters.
 * PASS = every compared metric within 0.5% relative. */
const fs = require("fs");
const { createClient } = require("@supabase/supabase-js");
const env = {};
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const svc = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const BILLSEC_EPOCH = "2026-07-28T00:00:00Z";

(async () => {
  const { data: rpc, error } = await svc.rpc("estimate_rates_v1", { p_parent_id: null, p_timezones: null });
  if (error) { console.error("RPC FAILED:", error.message); process.exit(1); }
  console.log("RPC:", JSON.stringify(rpc, null, 2).slice(0, 1200));

  // JS ground truth (keyset pagination — never trust a bare select)
  const from = new Date(Math.max(Date.now() - 30 * 86400e3, Date.parse(BILLSEC_EPOCH))).toISOString();
  const rows = [];
  let last = "1970-01-01T00:00:00Z";
  while (true) {
    const { data, error: e } = await svc.from("calls_v2")
      .select("created_at,hangup_cause,duration_seconds,campaign_number_id,campaigns_v2!campaign_id(is_test)")
      .gte("created_at", from).gt("created_at", last)
      .order("created_at", { ascending: true }).limit(1000);
    if (e) { console.error("page err:", e.message); process.exit(1); }
    rows.push(...data.filter((r) => r.campaigns_v2 && r.campaigns_v2.is_test === false));
    if (data.length < 1000) break;
    last = data[data.length - 1].created_at;
  }
  const byDay = {};
  for (const r of rows) (byDay[r.created_at.slice(0, 10)] ||= []).push(r);
  const healthy = Object.entries(byDay).filter(([, rs]) => {
    const rej = rs.filter((r) => r.hangup_cause === "CALL_REJECTED").length / rs.length;
    return rs.length >= 50 && rej <= 0.30;
  }).flatMap(([, rs]) => rs);
  const connected = healthy.filter((r) => r.hangup_cause === "NORMAL_CLEARING" && r.duration_seconds > 0);
  const js = {
    sampleDials: healthy.length,
    rConnect: connected.length / (healthy.length || 1),
    tTalkSec: connected.reduce((s, r) => s + r.duration_seconds, 0) / (connected.length || 1),
  };
  console.log("JS :", JSON.stringify(js));
  let fail = false;
  for (const k of Object.keys(js)) {
    const a = Number(rpc[k]), b = js[k];
    const rel = Math.abs(a - b) / (Math.abs(b) || 1);
    console.log(`${k}: rpc=${a} js=${typeof b === "number" ? b.toFixed(3) : b} rel=${(rel * 100).toFixed(2)}%  ${rel <= 0.005 ? "OK" : "MISMATCH"}`);
    if (rel > 0.005) fail = true;
  }
  console.log(fail ? "PARITY: FAIL" : "PARITY: PASS");
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
