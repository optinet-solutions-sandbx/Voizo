import { describe, expect, it } from "vitest";
import { groupPlayers, type PlayerHit } from "./playerGrouping";

const hit = (over: Partial<PlayerHit>): PlayerHit => ({
  numberId: "n", campaignId: "c", phone: "+6420000000", displayName: "Maria Horn", outcome: null,
  attemptCount: 0, lastAttemptedAt: null, smsSent: false, ...over,
});
const describe_ = (id: string) => ({ label: `Run ${id}`, dateIso: id === "c1" ? "2026-08-21" : id === "c2" ? "2026-08-22" : null, outcomeLabel: id === "c2" ? "Not interested" : "Unreached" });

describe("groupPlayers", () => {
  it("folds a player's hits into one entry, runs newest first, totals summed", () => {
    const players = groupPlayers([
      hit({ numberId: "a", campaignId: "c1", attemptCount: 3, lastAttemptedAt: "2026-08-21T10:00:00Z" }),
      hit({ numberId: "b", campaignId: "c2", attemptCount: 1, lastAttemptedAt: "2026-08-22T10:00:00Z", smsSent: true, displayName: null }),
    ], describe_);
    expect(players).toHaveLength(1);
    const p = players[0];
    expect(p.name).toBe("Maria Horn");
    expect(p.runs.map((r) => r.campaignId)).toEqual(["c2", "c1"]);
    expect(p.attempts).toBe(4);
    expect(p.smsSent).toBe(true);
    expect(p.lastAttemptedAt).toBe("2026-08-22T10:00:00Z");
    expect(p.latestOutcomeLabel).toBe("Not interested");
  });
  it("orders players by most recent touch, never-called last by name", () => {
    const players = groupPlayers([
      hit({ phone: "+1", displayName: "Zed", lastAttemptedAt: null }),
      hit({ phone: "+2", displayName: "Amy", lastAttemptedAt: null }),
      hit({ phone: "+3", displayName: "Bob", lastAttemptedAt: "2026-08-01T00:00:00Z" }),
      hit({ phone: "+4", displayName: "Cat", lastAttemptedAt: "2026-08-20T00:00:00Z" }),
    ], describe_);
    expect(players.map((p) => p.name)).toEqual(["Cat", "Bob", "Amy", "Zed"]);
  });
  it("keeps distinct numbers apart even under one name", () => {
    const players = groupPlayers([hit({ phone: "+1" }), hit({ phone: "+2" })], describe_);
    expect(players).toHaveLength(2);
  });
});
