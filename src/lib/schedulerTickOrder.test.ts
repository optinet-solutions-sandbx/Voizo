import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * VOZ-520 — the daily child spawn ran HOURS late (NZ 3.5–4h nightly, 11–13 Sep; one
 * FP NZ night never spawned at all) because the spawn branch sat LAST in the
 * campaign-scheduler tick, behind the dial fires. Two budget guards that never
 * composed: a resume fire may START while ≤30s have elapsed and then BLOCKS until the
 * phone stops ringing (modesl's bgapi callback fires on BACKGROUND_JOB, 8–22s per
 * ring), while a spawn may only start while ≤25s have elapsed. One 22s fire that
 * begins at second 5 already denies the spawn. With three Canadian campaigns dialling,
 * every tick was saturated and the spawn was deferred until Canada paused at 00:00Z.
 *
 * The fix is ORDER: spawn runs before the fires (and before the queue gate's early
 * return, which used to exit the tick before spawn on a full gate). Same reasoning as
 * callWindowGateSites.test.ts — the route has no unit harness, so the invariant is
 * asserted at source level and fails the moment someone moves the block back.
 */
const ROUTE = "src/app/api/cron/campaign-scheduler/route.ts";
const src = readFileSync(join(process.cwd(), ROUTE), "utf8");

const STALE_SWEEPER = "// ── Stale in_progress sweeper ──";
const SPAWN = "// ── Recurring child-spawn branch ──";
const RESUME_FIRES = "// ── Resume idle running campaigns where retries are due (B2) ──";
const QUEUE_GATE = "// ── Queue gate: concurrency limit on campaigns actually dialling ──";
const LIMIT_DECL = "const limit = parseInt(process.env.CAMPAIGN_CONCURRENCY_LIMIT";

const at = (marker: string) => {
  const i = src.indexOf(marker);
  // A renamed marker must fail loudly here, never pass by a −1 comparison below.
  expect(i, `marker not found in ${ROUTE}: ${marker}`).toBeGreaterThan(-1);
  expect(src.indexOf(marker, i + 1), `marker must be unique: ${marker}`).toBe(-1);
  return i;
};

describe("campaign-scheduler tick order (VOZ-520: spawn must not queue behind the dial fires)", () => {
  it("the recurring spawn branch runs BEFORE the resume fires", () => {
    expect(at(SPAWN)).toBeLessThan(at(RESUME_FIRES));
  });

  it("the recurring spawn branch runs BEFORE the queue gate's early return", () => {
    expect(at(SPAWN)).toBeLessThan(at(QUEUE_GATE));
  });

  it("the stale in_progress sweeper still runs BEFORE the spawn (reaped numbers roll over cleanly)", () => {
    expect(at(STALE_SWEEPER)).toBeLessThan(at(SPAWN));
  });

  it("`limit` (CAMPAIGN_CONCURRENCY_LIMIT) is declared before the spawn branch that reads it", () => {
    expect(at(LIMIT_DECL)).toBeLessThan(at(SPAWN));
  });
});
