import { describe, it, expect } from "vitest";
import { simulateScript, goalsOf } from "./scriptSimulator";
import type { ListenerScriptNode, ListenerScriptEdge } from "./database.types";

const node = (id: string, type: string, label: string, config: Record<string, unknown>, scenario_id: string | null = null) =>
  ({ id, script_id: "s", type, label, config, scenario_id, pos_x: 0, pos_y: 0, created_at: "", updated_at: "" }) as unknown as ListenerScriptNode;
const edge = (id: string, from: string, to: string) =>
  ({ id, script_id: "s", source_node_id: from, target_node_id: to, condition: { kind: "any" }, label: "" }) as unknown as ListenerScriptEdge;

const GOALS = ["Mention the 20 Free Spins", "Mention the 300% Deposit Bonus"];
const callGoalBox = node("goal", "step", "Call Goal", { contentType: "call_goal", statements: GOALS });

// start -> free spins beat -> bonus beat -> end, with a floating Call Goal box
function completeGraph() {
  const nodes = [
    node("start", "start", "Start", { opening: "Hey, Victor from Lucky Seven — have you logged in?" }),
    node("free", "step", "Free spins", { contentType: "scenario", statements: ["I've added twenty free spins to your account, and they expire soon."] }),
    node("bonus", "step", "Bonus", { contentType: "scenario", statements: ["Plus a three hundred percent bonus on your next deposit."] }),
    node("end", "step", "End", { contentType: "end" }),
    callGoalBox,
  ];
  const edges = [edge("e1", "start", "free"), edge("e2", "free", "bonus"), edge("e3", "bonus", "end")];
  return { nodes, edges };
}

describe("goalsOf", () => {
  it("gathers Call Goal box statements", () => {
    expect(goalsOf(completeGraph())).toEqual(GOALS);
  });
});

describe("simulateScript", () => {
  it("a complete script that delivers every goal passes clean", () => {
    const r = simulateScript(completeGraph(), []);
    expect(r.ok).toBe(true);
    expect(r.endPaths).toBe(1);
    expect(r.deadEndPaths).toBe(0);
    expect(r.goals.every((g) => g.everCovered && g.guaranteed)).toBe(true);
    expect(r.issues.filter((i) => i.level === "error")).toEqual([]);
  });

  it("flags a goal no box ever delivers (error)", () => {
    const g = completeGraph();
    // drop the bonus beat's line so goal 2 is never spoken
    g.nodes.find((n) => n.id === "bonus")!.config = { contentType: "scenario", statements: ["Anyway, that's all for now."] };
    const r = simulateScript(g, []);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.level === "error" && /never spoken/.test(i.text) && /300%/.test(i.text))).toBe(true);
  });

  it("flags repetition when a goal is authored in two boxes (warn)", () => {
    const g = completeGraph();
    // author the free-spins fact in the bonus box too
    g.nodes.find((n) => n.id === "bonus")!.config = {
      contentType: "scenario",
      statements: ["Plus a three hundred percent bonus.", "And remember those twenty free spins are waiting."],
    };
    const r = simulateScript(g, []);
    expect(r.issues.some((i) => i.level === "warn" && /Repetition risk/.test(i.text) && /Free Spins/i.test(i.text))).toBe(true);
  });

  it("flags a script with no End box (error)", () => {
    const g = completeGraph();
    g.nodes = g.nodes.filter((n) => n.id !== "end");
    g.edges = g.edges.filter((e) => e.id !== "e3");
    const r = simulateScript(g, []);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.level === "error" && /reaches an End/.test(i.text))).toBe(true);
  });

  it("warns when a goal is missed on some completed paths (early wrap-up branch)", () => {
    const g = completeGraph();
    // add a branch: start -> end directly (customer hangs up after the opener),
    // so the offer goals are missed on that completed path.
    g.edges.push(edge("e4", "start", "end"));
    const r = simulateScript(g, []);
    expect(r.endPaths).toBe(2);
    expect(r.goals.every((g) => g.everCovered)).toBe(true); // still delivered on the main path
    expect(r.goals.some((g) => !g.guaranteed && g.missedEndPaths >= 1)).toBe(true);
    expect(r.issues.some((i) => i.level === "warn" && /missed on/.test(i.text))).toBe(true);
  });
});
