/* trunkGateData.live.test.ts — MANUAL live-prod gate (VOZ-371).
 *
 * The harness beside this file fakes the query builder, which proves the gate's
 * LOGIC but not that the real PostgREST client satisfies the GateDb slice the
 * route casts it to. This drives the extracted resolveTrunkGate against the REAL
 * client, so that cast is evidence rather than assumption. Same shape and spirit
 * as dashboardRollup.parity.test.ts: skipped unless explicitly asked for.
 *
 *   RUN_GATE_LIVE=1 npx vitest run src/lib/scheduler/trunkGateData.live.test.ts
 *
 * READ-ONLY: the gate exposes no write verb. Re-run it after ANY change to the
 * gate's queries or to the GateDb interface.
 */
import fs from "fs";
import { describe, expect, it } from "vitest";
import { createClient } from "@supabase/supabase-js";
import { resolveTrunkGate, type GateDb } from "./trunkGateData";
import { TRUNK_WINDOW_HOURS } from "./trunkBreaker";

const RUN = process.env.RUN_GATE_LIVE === "1";
const env: Record<string, string> = {};
let envOk = false;
if (RUN) {
  // Guarded + quote-stripping (review 2026-08-14): a cwd without .env.local must
  // SKIP, not die at collection time, and KEY="..." must not keep its quotes.
  try {
    for (const l of fs.readFileSync(".env.local", "utf8").split(/\r?\n/)) {
      const i = l.indexOf("=");
      if (i > 0 && !l.startsWith("#")) {
        env[l.slice(0, i).trim()] = l.slice(i + 1).trim().replace(/^["']|["']$/g, "");
      }
    }
    envOk = !!(env.NEXT_PUBLIC_SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY);
  } catch {
    envOk = false;
  }
  if (!envOk) console.error("[gate.live] .env.local missing/incomplete — skipping (run from the repo root)");
}
const svc =
  RUN && envOk
    ? createClient(env.NEXT_PUBLIC_SUPABASE_URL!, env.SUPABASE_SERVICE_ROLE_KEY!, {
        auth: { persistSession: false, autoRefreshToken: false },
      })
    : (null as unknown as ReturnType<typeof createClient>);

describe.skipIf(!RUN || !envOk)("resolveTrunkGate against live prod", () => {
  // Assertions are INVARIANTS, never verdict values (review 2026-08-14): this
  // file's instruction is to re-run it after any gate change, and a test that
  // asserts "the trunk is HEALTHY today" goes red during a real outage or after
  // a quiet day — the predictable end state of that is the cast's only
  // validator being ignored. Verdicts are printed for the human instead.
  it("drives the real client through every gate path without violating an invariant", { timeout: 120_000 }, async () => {
    // Parents exactly as the route selects them.
    const { data: parents, error } = await svc
      .from("campaigns_v2")
      .select("id,name,timezone")
      .eq("campaign_type", "recurring")
      .eq("status", "running");
    if (error) throw new Error(error.message);
    const gateParents = (parents ?? []).map((p) => ({
      id: p.id as string,
      timezone: (p.timezone as string | null) ?? null,
    }));
    console.log("running recurring parents: " + gateParents.length);

    // ── A. NOW, against the real client end-to-end. Invariants only: the enum,
    // and "no probe unless REFUSING". (The count window measures the present
    // regardless of `now` — see the asymmetry note — so there is exactly one
    // meaningful live verdict, not one per historical tick.)
    const now = await resolveTrunkGate(svc as unknown as GateDb, gateParents, new Date());
    console.log("NOW      -> " + JSON.stringify(now));
    expect(["HEALTHY", "UNKNOWN", "REFUSING"]).toContain(now.health);
    if (now.health !== "REFUSING") expect(now.probeParentId).toBeNull();
    if (now.probeParentId !== null) expect(gateParents.map((p) => p.id)).toContain(now.probeParentId);

    // ── C. THE REFUSING PATH on real rows. The counts cannot be time-travelled
    // (see the asymmetry note on resolveTrunkGate), so stub ONLY the two calls_v2
    // counts to a refusing trunk and let every campaigns_v2 child lookup hit prod
    // for real — that is the half a fake cannot prove: real children, real
    // start_at values, real probe pick.
    // One recording chain per from("calls_v2"); the verdict is decided at await
    // time from the filters actually applied — the connected count is the one
    // carrying eq(hangup_cause). 107 dials / 0 connects = the 08-11 trunk.
    const stubCallsChain = (): Record<string, unknown> => {
      const ops: Array<{ m: string; a: unknown[] }> = [];
      const chain: Record<string, unknown> = {
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        then: (f?: (v: unknown) => unknown) => {
          const isConnected = ops.some((o) => o.m === "eq" && o.a[0] === "hangup_cause");
          return Promise.resolve(isConnected ? { count: 0, error: null } : { count: 107, error: null }).then(f);
        },
      };
      for (const m of ["select", "eq", "gt", "gte", "lt", "neq", "not", "order", "limit"]) {
        chain[m] = (...a: unknown[]) => { ops.push({ m, a }); return chain; };
      }
      return chain;
    };
    const refusingDb = (real: GateDb): GateDb => ({
      from: (table: string) =>
        table === "calls_v2"
          ? (stubCallsChain() as unknown as ReturnType<GateDb["from"]>)
          : real.from(table),
    });

    const outage = await resolveTrunkGate(
      refusingDb(svc as unknown as GateDb),
      gateParents,
      new Date("2026-08-11T22:31:00Z"),
    );
    console.log("REFUSING (real children) -> " + JSON.stringify(outage));
    expect(outage.health).toBe("REFUSING");
    expect(outage.probeParentId).not.toBeNull();
    expect(gateParents.map((p) => p.id)).toContain(outage.probeParentId);

    // ── D. Stability on real rows: a later tick the SAME day must pick the same
    // probe. The 08-12 outage was exactly this being unstable.
    const again = await resolveTrunkGate(
      refusingDb(svc as unknown as GateDb),
      gateParents,
      new Date("2026-08-11T23:59:00Z"),
    );
    console.log("REFUSING +88m            -> " + JSON.stringify(again));
    expect(again.probeParentId).toBe(outage.probeParentId);

    // ── D2. …and the NEXT day may rotate (never asserted equal — that is the point).
    const nextDay = await resolveTrunkGate(
      refusingDb(svc as unknown as GateDb),
      gateParents,
      new Date("2026-08-14T22:31:00Z"),
    );
    console.log("REFUSING next day        -> " + JSON.stringify(nextDay));
    expect(nextDay.probeParentId).not.toBeNull();

    // ── E. Sanity on the real count queries, hand-written with the same filters:
    // the client must return NUMBERS (a null count without an error is the
    // fail-closed hazard the gate now guards against). Values are printed, not
    // asserted — they decay with traffic.
    const since = new Date(Date.now() - TRUNK_WINDOW_HOURS * 3_600_000).toISOString();
    const [d, c] = await Promise.all([
      svc.from("calls_v2").select("id", { count: "exact", head: true })
        .gte("created_at", since).not("provider_call_id", "is", null),
      svc.from("calls_v2").select("id", { count: "exact", head: true })
        .gte("created_at", since).eq("hangup_cause", "NORMAL_CLEARING").gt("duration_seconds", 0),
    ]);
    console.log("raw counts: dials=" + d.count + " connected=" + c.count + " (26h)");
    expect(d.error).toBeNull();
    expect(c.error).toBeNull();
    expect(typeof d.count).toBe("number");
    expect(typeof c.count).toBe("number");
  });
});
