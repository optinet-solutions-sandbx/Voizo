/* _probe-rollup-parity.cjs — READ-ONLY dev harness for the dashboard SQL rollup.
 * Verifies the new Postgres rollup RPCs are reachable and shaped as expected.
 * The byte-parity assertions live in src/lib/dashboardRollup.parity.test.ts (vitest,
 * which can import the real TS aggregation functions). This probe is the quick
 * "are the RPCs applied and returning sane rows?" gate before running that test. */
const fs = require("fs");
const env = {};
for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
  const i = l.indexOf("="); if (i > 0 && !l.startsWith("#")) env[l.slice(0, i).trim()] = l.slice(i + 1).trim();
}
const SB = env.NEXT_PUBLIC_SUPABASE_URL, KEY = env.SUPABASE_SERVICE_ROLE_KEY;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };

/** POST a Postgres RPC (PostgREST /rpc/<name>). Returns {status, body}. */
async function callRpc(name, args) {
  const r = await fetch(`${SB}/rest/v1/rpc/${name}`, { method: "POST", headers: H, body: JSON.stringify(args) });
  const body = await r.json().catch(() => null);
  return { status: r.status, body };
}

/** Page every row of a REST query past PostgREST's 1000-row cap, keyed by id. */
async function pageAll(query) {
  let lastId = "00000000-0000-0000-0000-000000000000"; const out = [];
  while (true) {
    const r = await fetch(`${SB}/rest/v1/${query}&order=id.asc&id=gt.${lastId}&limit=1000`, { headers: H });
    const rows = await r.json();
    if (!Array.isArray(rows)) { throw new Error(`pageAll ${query}: ${JSON.stringify(rows).slice(0, 300)}`); }
    out.push(...rows);
    if (rows.length < 1000) return out;
    lastId = rows[rows.length - 1].id;
  }
}

module.exports = { callRpc, pageAll, SB, H };

// Direct run = smoke check.
if (require.main === module) {
  (async () => {
    console.log("harness ready");
    const start = new Date(Date.now() - 2 * 86400000).toISOString();
    const end = new Date().toISOString();
    for (const name of ["dashboard_call_rollup", "dashboard_sms_rollup"]) {
      const { status, body } = await callRpc(name, { p_start: start, p_end: end });
      if (status !== 200) { console.log(`  ${name}: HTTP ${status} — not applied yet? ${JSON.stringify(body).slice(0, 160)}`); continue; }
      const n = Array.isArray(body) ? body.length : "?";
      console.log(`  ${name}: ${n} rows (2-day window). sample: ${JSON.stringify(Array.isArray(body) ? body[0] : body)}`);
    }
  })().catch((e) => { console.error("PROBE FAILED:", e.message); process.exit(1); });
}
