import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * VOZ-527 — a pause that strands its SIP slot silently shrinks the dialing fleet.
 *
 * The scheduler tick has THREE writers that flip a dialing child to `paused`:
 * the reject/trunk circuit breaker (VOZ-278), the budget guardrail, and the
 * outside-call-window close. Only the window close released the child's Vapi
 * clone + pool slot; the other two left both pinned to a campaign that would
 * never dial again.
 *
 * A stranded slot is NOT self-healing on any useful timescale. The only other
 * reclaim path is rolloverLeftovers (realtimePoll.ts), which runs as part of the
 * parent's NEXT spawn — so the slot is held until tomorrow, and if the parent
 * stops spawning at all it is held forever. Measured 2026-09-15: 4 of the 10
 * slots in CAMPAIGN_CONCURRENCY_LIMIT were held by dead campaigns (one for 20
 * days, since 2026-08-26), and the shortfall cost an Australian lane its whole
 * day — the 4th AU parent hit `budget_full` at 22:33Z and could not spawn until
 * 08:01Z the next morning, when the New Zealand children released at their
 * window close.
 *
 * Worse, the reclaim path is circular: freeing a slot requires a spawn, and a
 * spawn requires a free slot. A pool fully held by un-rolled-over children
 * cannot spawn anything to free itself.
 *
 * ── WHY SOURCE-LEVEL ──
 * These three sites live inside one ~700-line cron GET handler with no unit
 * harness — the same reason callWindowGateSites.test.ts asserts at the source
 * level. Standing up a Supabase fake for the whole tick to cover a 4-line
 * release block would cost more than it protects, and the mutation risk is
 * identical: deleting the release leaves the entire suite green.
 *
 * ── THE INVARIANT ──
 * A site that pauses a slot-holding campaign must do BOTH, or it is a leak:
 *
 *   1. NULL the three Vapi pointer columns in the SAME update that pauses it.
 *      Releasing the slot while the row still points at it is the 2026-08-12
 *      dead-dialer shape in reverse — the next lessee owns that slot, and this
 *      row still claims it.
 *   2. Call performCampaignVapiCleanup AFTER the update lands, so the SIP phone
 *      is detached, the pool row goes back to `free`, and the billable clone is
 *      deleted.
 *
 * ── WHEN THIS TEST FAILS ──
 * Loudly, and on purpose, in three cases. (a) A new pauser is added without a
 * release — the case this exists for. (b) The release is refactored behind a
 * helper, so the identifiers no longer appear inline; that is exactly the change
 * where a human should re-confirm the invariant by hand before updating the
 * matcher. (c) A pauser is added for a campaign class that genuinely holds no
 * slot (a recurring parent — today impossible here, the sweep's query carries
 * `.neq("campaign_type", "recurring")`). Failing loudly and making that author
 * decide is the right outcome; a silent exemption marker is not.
 */
const SCHEDULER = "src/app/api/cron/campaign-scheduler/route.ts";

/** Pointer columns that must be cleared in the same update that pauses the row. */
const POINTER_COLUMNS = ["vapi_assistant_id", "vapi_pool_slot_id", "vapi_sip_uri"];

const isComment = (l: string) => {
  const t = l.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/**
 * Every `status: "paused"` write in the file, paired with the branch that
 * follows it — scanned to the `continue` that ends the branch, with a 60-line
 * cap so a missing `continue` can never swallow the NEXT site and make this
 * test pass by borrowing its neighbour's release call.
 */
function pauseSites(src: string): Array<{ no: number; block: string }> {
  const lines = src.split(/\r?\n/);
  const out: Array<{ no: number; block: string }> = [];
  lines.forEach((line, i) => {
    if (!/status:\s*"paused"/.test(line) || isComment(line)) return;
    const parts: string[] = [];
    for (let j = i; j < lines.length && j - i < 60; j++) {
      parts.push(lines[j]);
      if (/^\s*continue;\s*$/.test(lines[j])) break;
    }
    out.push({ no: i + 1, block: parts.join("\n") });
  });
  return out;
}

describe("VOZ-527: every scheduler pause of a dialing child must release its SIP slot", () => {
  const src = readFileSync(join(process.cwd(), SCHEDULER), "utf8");
  const sites = pauseSites(src);

  it("finds every pause writer in the tick", () => {
    // A vacuous pass is the one outcome worse than a failure here: if the write
    // is reshaped (a constant, a helper, a spread) this finds nothing and every
    // assertion below silently succeeds. Three sites exist as of 2026-09-15 —
    // breaker, budget, window close.
    expect(
      sites.length,
      `no \`status: "paused"\` writes found in ${SCHEDULER}. The matcher has gone ` +
        `stale — fix it before trusting this file, it is currently asserting nothing.`,
    ).toBeGreaterThanOrEqual(3);
  });

  for (const { no, block } of sites) {
    it(`${SCHEDULER}:${no} clears its Vapi pointers and releases the slot`, () => {
      for (const col of POINTER_COLUMNS) {
        expect(
          block.includes(col),
          `${SCHEDULER}:${no} pauses a dialing child without clearing \`${col}\`. ` +
            `The row would keep pointing at a slot/clone it no longer owns — see the ` +
            `2026-08-12 dead-dialer incident. Null all of ${POINTER_COLUMNS.join(", ")} ` +
            `in the SAME update that writes the pause.`,
        ).toBe(true);
      }

      expect(
        block.includes("performCampaignVapiCleanup"),
        `${SCHEDULER}:${no} pauses a dialing child but never calls ` +
          `performCampaignVapiCleanup, so its SIP pool slot stays \`leased\` and its ` +
          `Vapi clone stays billable. Nothing else will reclaim them today: the only ` +
          `other path is rolloverLeftovers at the parent's NEXT spawn, and a parent ` +
          `that stops spawning holds the slot forever (measured: one held since ` +
          `2026-08-26). Mirror the outside-window block in this same loop.`,
      ).toBe(true);
    });
  }
});
