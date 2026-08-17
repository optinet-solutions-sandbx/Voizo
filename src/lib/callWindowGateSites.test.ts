import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * VOZ-364 — guards the LOAD-BEARING half of the fail-closed call-window fix.
 *
 * Making isWithinCallWindowAt return false on an empty window is not enough on its
 * own: several dial-path callers carried their OWN pre-guard on the window value, so
 * on an unconfigured window they skipped the shared gate entirely and dialled anyway.
 * That is a caller-local fail-open, independent of the gate's own default.
 *
 * A mutation test proved the gap: re-introducing one of those pre-guards left the
 * whole suite green (1,224 passing), because these are route handlers with no unit
 * coverage. Rather than stand up supabase mock harnesses for each, this asserts the
 * invariant at the source level — it fails the moment a pre-guard comes back.
 *
 * ── THE INVARIANT IS ABOUT SKIPPING, NOT ABOUT BEING UNCONDITIONAL ──
 * Two different things can sit in front of this gate, and only one is a bug:
 *
 *   ✗ PRE-GUARD ON THE WINDOW VALUE (banned). Either shape:
 *       arity     — `callWindows.length > 0 && !isWithinCallWindow(...)`
 *       truthiness— `callWindows && !isWithinCallWindow(...)`
 *     Both SKIP the gate because the window is unset, for a row that CAN dial. An
 *     unconfigured window must reach the gate and be DENIED, never skipped. The
 *     truthiness shape is not hypothetical: voice-status/route.ts carried exactly
 *     `callWindows &&` before this ticket, and it contains no `.length` to grep for.
 *
 *   ✓ SCOPE EXCLUSION (allowed) — `!isRecurringParent &&`, `.neq("campaign_type",
 *     "recurring")`. Removes the gate from a ROW CLASS that cannot dial at all. A
 *     recurring parent never dials; it spawns children that carry their own windows
 *     and are gated individually (campaign-scheduler/route.ts:555). Existing
 *     convention in this codebase — the queue gate and the scheduler query both use it.
 *
 *   ✓ DENY-ON-MISSING (allowed) — `!timezone || !isWithinCallWindow(...)`. Negated and
 *     OR-ed, so an absent config value DENIES rather than skips. Same direction as
 *     the gate; that is the point.
 *
 * So a conditional gate is not automatically a regression — a gate skipped because
 * the window is EMPTY is. Keep that distinction when editing this file.
 */
const DIAL_PATH_GATE_SITES = [
  "src/app/api/cron/campaign-scheduler/route.ts",
  "src/app/api/campaigns-v2/[id]/start/route.ts",
  "src/app/api/webhooks/freeswitch/voice-status/route.ts",
];

const readSite = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");
const isComment = (l: string) => {
  const t = l.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
};

/**
 * Every `if (...)` condition in the file that consults the call-window gate, returned
 * as ONE joined string per site so a Prettier-wrapped multi-line condition is matched
 * the same as a single-line one. Walks BACK from the gate call to its enclosing
 * `if (`, so only the condition is captured — never unrelated neighbouring code.
 */
function gateConditions(src: string): Array<{ text: string; no: number }> {
  const lines = src.split(/\r?\n/);
  const out: Array<{ text: string; no: number }> = [];
  lines.forEach((line, i) => {
    if (!/\bisWithinCallWindow\s*\(/.test(line) || isComment(line)) return;
    const parts: string[] = [];
    for (let j = i; j >= 0 && i - j < 8; j--) {
      if (isComment(lines[j])) continue;
      parts.unshift(lines[j]);
      if (/\bif\s*\(/.test(lines[j])) break;
    }
    out.push({ text: parts.join(" ").replace(/\s+/g, " "), no: i + 1 });
  });
  return out;
}

describe("VOZ-364: dial-path call-window gates must deny an unconfigured window, never skip it", () => {
  for (const rel of DIAL_PATH_GATE_SITES) {
    it(`${rel} has no pre-guard on the window value`, () => {
      const conditions = gateConditions(readSite(rel));

      // If this trips, the gate call was renamed or removed — not a pass.
      expect(conditions.length, `no isWithinCallWindow call found in ${rel}`).toBeGreaterThan(0);

      for (const { text, no } of conditions) {
        // Name of the window argument actually passed to the gate, e.g. `cw` in
        // `isWithinCallWindow(cw ?? [], tz)`. The ban is specific to THAT value, so a
        // campaign-type exclusion on a different identifier stays legal.
        const argMatch = text.match(/isWithinCallWindow\s*\(\s*([A-Za-z_$][\w$]*)/);
        const win = argMatch?.[1];
        expect(win, `${rel}:${no}: could not identify the window argument in: ${text}`).toBeTruthy();

        // `win &&` / `win?.length` / `win.length > 0 &&` anywhere in the condition —
        // i.e. the gate is consulted only when the window is already non-empty.
        const preGuard = new RegExp(
          `\\b${win}\\s*(?:&&|\\?\\.length|\\.length\\s*(?:>\\s*0|!==\\s*0|>=\\s*1))`,
        );
        expect(
          preGuard.test(text),
          `${rel}:${no} re-introduces a pre-guard on the call-window value "${win}". An ` +
            `unconfigured (empty/null) window must reach the shared gate and be DENIED, not ` +
            `skipped — that is the VOZ-364 fail-open. A campaign-TYPE scope exclusion is fine, ` +
            `and so is a negated OR-ed deny like \`!timezone || !gate(...)\`; a truthiness or ` +
            `arity check on the window itself is not. Offending condition:\n  ${text}`,
        ).toBe(false);
      }
    });
  }

  // The scope exclusion itself is a behaviour guarantee worth pinning: without it the
  // fail-closed gate 400s forever on the 9 recurring parents that hold call_windows=[],
  // so an operator can never resume a paused parent. Route handlers here have no unit
  // coverage, so assert it at the source level too.
  it("campaigns-v2/[id]/start scope-excludes recurring parents from the window gate", () => {
    const rel = "src/app/api/campaigns-v2/[id]/start/route.ts";
    const conditions = gateConditions(readSite(rel));

    expect(
      conditions.some(({ text }) => /isRecurringParent|campaign_type/.test(text)),
      `${rel}: the window gate is no longer scope-excluded for recurring parents. A ` +
        `recurring parent never dials, and the gate now fails CLOSED, so without this ` +
        `exclusion every paused parent holding call_windows=[] becomes impossible to ` +
        `resume (permanent 400). Note the parent's own "doesn't dial" early return can ` +
        `NOT be hoisted above the gate to cover this: it reports {status:"running"} only ` +
        `because the atomic UPDATE ran first, so hoisting it returns success while the ` +
        `row stays paused.`,
    ).toBe(true);
  });
});
