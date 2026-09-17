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

/** Fake `alert_state` contents for the current test, keyed by `key`. */
let alertStateRows: Record<string, string> = {};
/** When set, every alert_state READ fails with this error (fail-open probe). */
let alertStateReadError: { message: string } | null = null;
/** Every alert_state upsert the route performed this test, in order. */
let alertStateUpserts: { key: string; last_alerted_at: string }[] = [];

/**
 * Mock both tables the route touches. `cron_heartbeats` answers the
 * select().in() the classifier uses; `alert_state` answers the
 * select().eq().maybeSingle() + upsert() the dedupe uses. Dispatching on the
 * table NAME (rather than one shared shape) is what keeps a wrong-table call
 * visible instead of silently returning heartbeat rows to the dedupe.
 */
function mockHeartbeats(data: Row[]) {
  alertStateRows = {};
  alertStateReadError = null;
  alertStateUpserts = [];
  (supabaseAdmin.from as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
    if (table === "alert_state") {
      return {
        select: () => ({
          eq: (_col: string, key: string) => ({
            maybeSingle: async () =>
              alertStateReadError
                ? { data: null, error: alertStateReadError }
                : {
                    data: alertStateRows[key] ? { last_alerted_at: alertStateRows[key] } : null,
                    error: null,
                  },
          }),
        }),
        upsert: async (row: { key: string; last_alerted_at: string }) => {
          alertStateUpserts.push(row);
          return { error: null };
        },
      };
    }
    return { select: () => ({ in: async () => ({ data, error: null }) }) };
  });
}

/** Pretend we already alerted about `cronName` at `lastAlertedAtIso`. */
function setAlertedAt(cronName: string, lastAlertedAtIso: string) {
  alertStateRows[`cron_missing:${cronName}`] = lastAlertedAtIso;
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

// 2026-09-17. Part 2 made a never-succeeded cron WARN, but this route has no
// dedupe, so a cron that is BORN broken (the exact case Part 2 exists for) posts
// every tick — 24 identical messages a day, indefinitely, because nothing about
// "never succeeded" self-clears. On the day this shipped, TWO crons were in that
// state (daily-snapshot blocked on DNS, mobivate-reconcile on parser defects), so
// the channel that is supposed to catch the NEXT silent cron death would have been
// the loudest thing in it. An alarm nobody can silence is an alarm everybody mutes.
//
// The dedupe is deliberately scoped to the `missing` bucket only, keyed per cron
// in alert_state, and it gates the Slack POST alone: the JSON response and the
// summary log keep naming every unhealthy cron. Dedupe hides the notification,
// never the diagnosis.
describe("GET /api/cron/alerts-hourly — the never-succeeded alert dedupes per cron", () => {
  const snapshot = CRON_NAMES.dailySnapshot;

  it("stays quiet on the next tick for a cron already alerted about inside the window", async () => {
    mockHeartbeats(rows([snapshot]));
    setAlertedAt(snapshot, iso(60 * 60)); // alerted 1h ago

    const res = await GET(req());

    expect(postSlackAlert).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("posts again once the dedupe window has passed", async () => {
    mockHeartbeats(rows([snapshot]));
    setAlertedAt(snapshot, iso(25 * 60 * 60)); // 25h ago, window is 24h

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.text).toContain(snapshot);
  });

  // The failure mode that would make this change WORSE than no dedupe: muting one
  // broken cron must never mute the next one to break.
  it("a newly missing cron still alerts while a different one is inside its window", async () => {
    mockHeartbeats(rows([snapshot, CRON_NAMES.goldenReplay]));
    setAlertedAt(snapshot, iso(60 * 60));

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.text).toContain(CRON_NAMES.goldenReplay);
    expect(posted()!.text).not.toContain(snapshot);
  });

  // Mirrors the trunk-gate precedent in campaign-scheduler: fail OPEN on the
  // dedupe read, because a broken dedupe row must not silence a real alert.
  it("alerts anyway when the dedupe read fails", async () => {
    mockHeartbeats(rows([snapshot]));
    alertStateReadError = { message: "connect ETIMEDOUT" };

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.text).toContain(snapshot);
  });

  // Regression guard: `stale` is a DIFFERENT failure class (a cron that worked and
  // then stopped) and its hourly alerting is pre-existing, accepted behaviour. This
  // change must not quiet it, not even when a same-named dedupe key exists.
  it("never dedupes the stale bucket", async () => {
    const scheduler = CRON_NAMES.scheduler;
    mockHeartbeats(
      rows([scheduler], [
        { name: scheduler, last_success_at: iso(CRON_STALENESS_THRESHOLD_SECONDS[scheduler] + 60) },
      ]),
    );
    setAlertedAt(scheduler, iso(60)); // alerted a minute ago — stale must speak anyway

    await GET(req());

    expect(posted()).not.toBeNull();
    expect(posted()!.text).toContain(scheduler);
  });

  it("keeps the JSON diagnosis truthful while Slack is muted", async () => {
    mockHeartbeats(rows([snapshot]));
    setAlertedAt(snapshot, iso(60 * 60));

    const body = await (await GET(req())).json();

    expect(postSlackAlert).not.toHaveBeenCalled();
    expect(body.severity).toBe("WARN");
    expect(body.summary.missing).toBe(1);
    expect(body.summary.missing_suppressed).toBe(1);
  });

  it("stamps the dedupe key after Slack accepted the post", async () => {
    mockHeartbeats(rows([snapshot]));

    await GET(req());

    expect(alertStateUpserts.map((u) => u.key)).toEqual([`cron_missing:${snapshot}`]);
  });

  // Stricter than the trunk-gate precedent, which stamps unconditionally. Stamping
  // a post Slack never accepted would swallow the alert for a full window — the
  // same silent-failure class this whole ticket exists to remove.
  it("does not stamp when the Slack post failed, so the next tick retries", async () => {
    (postSlackAlert as ReturnType<typeof vi.fn>).mockResolvedValueOnce(false);
    mockHeartbeats(rows([snapshot]));

    await GET(req());

    expect(postSlackAlert).toHaveBeenCalled();
    expect(alertStateUpserts).toHaveLength(0);
  });
});
