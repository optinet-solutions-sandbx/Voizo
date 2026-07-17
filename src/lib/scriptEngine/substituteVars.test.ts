import { describe, it, expect } from "vitest";
import { substituteVars } from "./substituteVars";

// Greet-by-name Ramp 2 (2026-07-17): script authors write {{playerName}} in
// statements/templates; the engine substitutes from lab_call_flow_state.variables
// at the push points. Jas's rule: name present → use it; absent → SAME line,
// naturally worded — so a missing variable strips the token and tidies the seam
// (the agent must never speak "curly-brace playerName").
describe("substituteVars", () => {
  it("replaces {{playerName}} with the seeded value", () => {
    expect(substituteVars("Hi {{playerName}}, it's Tom from Lucky Seven.", { playerName: "Kassandra" }))
      .toBe("Hi Kassandra, it's Tom from Lucky Seven.");
  });

  it("tolerates whitespace inside the braces and repeated tokens", () => {
    expect(substituteVars("{{ playerName }}? Great to reach you, {{playerName}}!", { playerName: "Vicky" }))
      .toBe("Vicky? Great to reach you, Vicky!");
  });

  it("strips the token and tidies punctuation when the variable is missing", () => {
    expect(substituteVars("Hi {{playerName}}, it's Tom.", {})).toBe("Hi, it's Tom.");
    expect(substituteVars("Thanks {{playerName}} !", undefined)).toBe("Thanks!");
    expect(substituteVars("Is this {{playerName}} ?", null)).toBe("Is this?");
  });

  it("strips empty-string and non-string variable values too", () => {
    expect(substituteVars("Hi {{playerName}}, hello.", { playerName: "" })).toBe("Hi, hello.");
    expect(substituteVars("Hi {{playerName}}, hello.", { playerName: 42 as unknown as string })).toBe("Hi, hello.");
  });

  it("substitutes any seeded key and strips unknown ones", () => {
    expect(substituteVars("{{greetingName}} — your {{bonus}} awaits {{unknown}}.", { greetingName: "René", bonus: "20 spins" }))
      .toBe("René — your 20 spins awaits.");
  });

  it("returns text without tokens untouched (fast path)", () => {
    const line = "No placeholders here, plain sentence.";
    expect(substituteVars(line, { playerName: "X" })).toBe(line);
  });

  it("never eats newlines in multi-line briefings (tidy is intra-line only)", () => {
    // Armed briefings are newline-joined bullet menus; a stripped token at a
    // line start must not merge two menu options into one (review finding
    // 2026-07-17). An orphan comma is acceptable; a lost line break is not.
    const briefing = "Answer with the best line:\n  - {{playerName}}, listen carefully\n  - next option";
    const out = substituteVars(briefing, {});
    expect(out.split("\n")).toHaveLength(3);
    expect(out).toContain("\n  - next option");
  });
});
