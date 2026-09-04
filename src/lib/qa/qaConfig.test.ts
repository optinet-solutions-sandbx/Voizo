// The pause gate (Jasiel 2026-09-04). The point of the flag is that it stops the CRON without
// making the judge unusable by hand, so the thing worth pinning is that the two gates are
// independent and that the paused state is the DEFAULT.
// qaConfig reads process.env at module load, so each case re-imports it with a fresh registry.
import { describe, it, expect, beforeEach, vi } from "vitest";

async function loadConfig(env: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  return import("./qaConfig");
}

const READY = { QA_JUDGE_ENABLED: "true", QA_JUDGE_PROVIDER: "openai", OPENAI_API_KEY: "sk-test" };

describe("automatic scoring is paused by default", () => {
  beforeEach(() => {
    for (const k of ["QA_JUDGE_ENABLED", "QA_JUDGE_PROVIDER", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "QA_JUDGE_AUTO"]) {
      delete process.env[k];
    }
  });

  it("leaves the judge usable while the cron is paused", async () => {
    const c = await loadConfig({ ...READY, QA_JUDGE_AUTO: undefined });
    expect(c.qaJudgeReady()).toBe(true); // Score all still works
    expect(c.qaAutoGradingOn()).toBe(false); // the cron does not
  });

  it("needs no env change to be paused: absent reads as off", async () => {
    const c = await loadConfig({ ...READY });
    expect(c.QA_JUDGE_AUTO).toBe(false);
  });

  it("resumes only on the exact string true", async () => {
    expect((await loadConfig({ ...READY, QA_JUDGE_AUTO: "true" })).qaAutoGradingOn()).toBe(true);
    for (const v of ["TRUE", "1", "yes", "", "false"]) {
      expect((await loadConfig({ ...READY, QA_JUDGE_AUTO: v })).qaAutoGradingOn()).toBe(false);
    }
  });

  it("stays off when the judge itself cannot run, even if auto is set", async () => {
    const noKey = await loadConfig({ QA_JUDGE_ENABLED: "true", QA_JUDGE_PROVIDER: "openai", OPENAI_API_KEY: undefined, QA_JUDGE_AUTO: "true" });
    expect(noKey.qaJudgeReady()).toBe(false);
    expect(noKey.qaAutoGradingOn()).toBe(false);

    const flagOff = await loadConfig({ QA_JUDGE_ENABLED: undefined, QA_JUDGE_PROVIDER: "openai", OPENAI_API_KEY: "sk-test", QA_JUDGE_AUTO: "true" });
    expect(flagOff.qaAutoGradingOn()).toBe(false);
  });
});
