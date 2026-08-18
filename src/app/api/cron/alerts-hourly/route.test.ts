import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// Relative mocks (vitest does not resolve "@/"). supabaseAdmin is the env-throwing
// service-role singleton, and the Slack dispatcher is spied so severity + details
// can be asserted with no network call. CRON_NAMES and the threshold table stay
// REAL — the point of these tests is that the classifier is measured against the
// system's OWN yardstick, not a copy of it.
vi.mock("../../../../lib/supabaseServer", () => ({ supabaseAdmin: { from: vi.fn() } }));
vi.mock("../../../../lib/alerts/slack", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/alerts/slack")>();
  return {
    ...actual,
    postSlackAlert: vi.fn(async () => true),
    recordHeartbeat: vi.fn(async () => {}),
  };
});

import { GET } from "./route";
import { supabaseAdmin } from "../../../../lib/supabaseServer";
import {
  CRON_NAMES,
  CRON_STALENESS_THRESHOLD_SECONDS,
  postSlackAlert,
  type CronName,
} from "../../../../lib/alerts/slack";

const CRON_SECRET = "test-cron-secret";
const NOW = Date.now();
const ALL: CronName[] = Object.values(CRON_NAMES);

type Row = { name: string; last_success_at: string };

const iso = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString();

/** Every expected cron ticked 10s ago, minus `omit`, plus `overrides`. */
function rows(omit: CronName[] = [], overrides: Row[] = []): Row[] {
  return [
    ...ALL.filter((n) => !omit.includes(n)).map((n) => ({ name: n, last_success_at: iso(10) })),
    ...overrides,
  ];
}

function mockHeartbeats(data: Row[]) {
  (supabaseAdmin.from as ReturnType<typeof vi.fn>).mockReturnValue({
    select: () => ({ in: async () => ({ data, error: null }) }),
  });
}

function req(): NextRequest {
  return { headers: new Headers({ authorization: `Bearer ${CRON_SECRET}` }) } as unknown as NextRequest;
}

/** The (severity, title, details) the dispatcher was handed, or null if it stayed quiet. */
function posted() {
  const calls = (postSlackAlert as ReturnType<typeof vi.fn>).mock.calls;
  if (calls.length === 0) return null;
  const [severity, title, details] = calls[0] as [string, string, string[]];
  return { severity, title, text: details.join("\n"), callCount: calls.length };
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = CRON_SECRET;
});

// VOZ-358 Part 2 / 2026-08-18. daily-snapshot ran and FAILED every day for 40
// days (sendEmail throws -> 500 -> the heartbeat UPSERT on the next line never
// runs), so it has NO row. alerts-hourly classifies no-row as `missing` and the
// `missing` branch is INFO-only by design — console.log, explicitly no Slack
// post, guarded as a "first-deploy false positive" with NO EXPIRY. A cron that
// dies after working is caught; a cron born broken is invisible forever.
describe("GET /api/cron/alerts-hourly — a cron that has NEVER succeeded must alert", () => {
  it("alerts when an expected cron has no heartbeat row at all", async () => {
    mockHeartbeats(rows([CRON_NAMES.dailySnapshot]));

    const res = await GET(req());
    const body = await res.json();

    expect(posted()).not.toBeNull();
    expect(posted()!.severity).toBe("WARN");
    expect(posted()!.text).toContain(CRON_NAMES.dailySnapshot);
    expect(body.severity).toBe("WARN");
  });

  it("does not let a stale cron mask a never-succeeded one — both appear in one alert", async () => {
    const scheduler = CRON_NAMES.scheduler;
    mockHeartbeats(
      rows([scheduler, CRON_NAMES.dailySnapshot], [
        { name: scheduler, last_success_at: iso(CRON_STALENESS_THRESHOLD_SECONDS[scheduler] + 60) },
      ]),
    );

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.callCount).toBe(1);
    expect(posted()!.text).toContain(scheduler);
    expect(posted()!.text).toContain(CRON_NAMES.dailySnapshot);
  });

  // The M3 guard (route.ts:125-142) routes corrupt/future timestamps to `missing`
  // with the comment "Both mask a real failure" — but `missing` is the silent
  // bucket, so the guard swaps one silent misclassification for another.
  it("alerts on an unusable last_success_at instead of downgrading it to INFO", async () => {
    mockHeartbeats(
      rows([CRON_NAMES.goldenReplay], [
        { name: CRON_NAMES.goldenReplay, last_success_at: "not-a-timestamp" },
      ]),
    );

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.severity).toBe("WARN");
    expect(posted()!.text).toContain(CRON_NAMES.goldenReplay);
  });

  // Positive control: a detector that cannot stay quiet is useless (VOZ-358's own
  // acceptance language). This one passes BEFORE and AFTER the fix.
  it("stays QUIET when every expected cron is inside its own threshold", async () => {
    mockHeartbeats(rows());

    const res = await GET(req());

    expect(postSlackAlert).not.toHaveBeenCalled();
    expect((await res.json()).severity).toBe("OK");
  });
});
