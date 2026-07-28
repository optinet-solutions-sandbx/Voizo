import { describe, it, expect } from "vitest";
import { buildScriptFromPlan, normalizePlan, type ScriptPlan } from "./scriptGenerator";
import { simulateScript } from "./scriptSimulator";
import type { ListenerScriptNode, ListenerScriptEdge, ListenerHandler } from "./database.types";

const PLAN: ScriptPlan = {
  name: "Test Brand",
  persona: "You are Sam from the casino.",
  opening: "Hi, quick question — do you have a sec?",
  beats: [
    { label: "Free spins", line: "I've added twenty free spins to your account, and they expire soon." },
    { label: "Bonus", line: "Plus a three hundred percent bonus on your next deposit." },
  ],
  concerns: [
    { name: "Who", when: "asks who is calling", answer: "It's Sam from the casino." },
    { name: "Legit", when: "asks if this is legit", answer: "Your number is on your account with us." },
  ],
  goals: ["The twenty free spins on their account", "The three hundred percent deposit bonus"],
  close: "Thanks so much — have a great day!",
};

describe("buildScriptFromPlan", () => {
  const a = buildScriptFromPlan(PLAN);

  it("assembles the right pieces", () => {
    expect(a.handlers.length).toBe(5); // 2 beats + 2 concerns + close
    expect(a.nodes.length).toBe(6); // start + 2 beats + wrap + end + call_goal
    expect(a.edges.length).toBe(4); // start→beat1→beat2→wrap→end
    expect(a.collectionHandlerIds.length).toBe(2);
    expect(a.nodes.filter((n) => (n.config as { contentType?: string }).contentType === "call_goal").length).toBe(1);
    expect(a.nodes.find((n) => n.type === "start")).toBeTruthy();
    expect(a.nodes.some((n) => (n.config as { contentType?: string }).contentType === "end")).toBe(true);
  });

  it("the generated graph passes the simulator (goals covered, reaches End)", () => {
    const graph = { nodes: a.nodes as unknown as ListenerScriptNode[], edges: a.edges as unknown as ListenerScriptEdge[] };
    const sim = simulateScript(graph, a.handlers as unknown as ListenerHandler[]);
    expect(sim.ok).toBe(true);
    expect(sim.endPaths).toBeGreaterThanOrEqual(1);
    expect(sim.goals.every((g) => g.everCovered && g.guaranteed)).toBe(true);
  });
});

describe("normalizePlan", () => {
  it("fills defaults and drops malformed entries, never throws", () => {
    const p = normalizePlan({ beats: [{ line: "" }, { label: "Ok", line: "A real beat." }], goals: ["", "Real goal"], concerns: [{}] }, "Acme");
    expect(p.name).toContain("Acme");
    expect(p.opening.length).toBeGreaterThan(0);
    expect(p.close.length).toBeGreaterThan(0);
    expect(p.beats).toEqual([{ label: "Ok", line: "A real beat." }]);
    expect(p.goals).toEqual(["Real goal"]);
    expect(p.concerns).toEqual([]); // the empty concern is dropped
  });
  it("handles total garbage", () => {
    const p = normalizePlan(null, "Acme");
    expect(p.beats.length).toBeGreaterThanOrEqual(1);
    expect(p.close.length).toBeGreaterThan(0);
  });
});
