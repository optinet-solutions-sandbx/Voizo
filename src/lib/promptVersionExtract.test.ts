import { describe, it, expect } from "vitest";
import {
  extractEffectiveSystemPrompt,
  extractModelMeta,
  extractVoiceMeta,
  sha256Hex,
} from "./promptVersionExtract";

describe("extractEffectiveSystemPrompt", () => {
  it("returns the system message content from a well-formed assistant", () => {
    const a = { model: { messages: [{ role: "system", content: "hello" }] } };
    expect(extractEffectiveSystemPrompt(a)).toBe("hello");
  });
  it("returns the FIRST system message when several exist", () => {
    const a = { model: { messages: [{ role: "system", content: "first" }, { role: "system", content: "second" }] } };
    expect(extractEffectiveSystemPrompt(a)).toBe("first");
  });
  it("ignores non-system roles", () => {
    const a = { model: { messages: [{ role: "user", content: "u" }, { role: "system", content: "sys" }] } };
    expect(extractEffectiveSystemPrompt(a)).toBe("sys");
  });
  it("returns null when there is no system message", () => {
    expect(extractEffectiveSystemPrompt({ model: { messages: [{ role: "user", content: "u" }] } })).toBeNull();
  });
  it("returns null for empty-string content (don't store a garbage row)", () => {
    expect(extractEffectiveSystemPrompt({ model: { messages: [{ role: "system", content: "" }] } })).toBeNull();
  });
  it("returns null for non-string content", () => {
    expect(extractEffectiveSystemPrompt({ model: { messages: [{ role: "system", content: { x: 1 } }] } })).toBeNull();
  });
  it("returns null when messages is missing / not an array", () => {
    expect(extractEffectiveSystemPrompt({ model: {} })).toBeNull();
    expect(extractEffectiveSystemPrompt({ model: { messages: "nope" } })).toBeNull();
  });
  it("returns null on null / undefined / non-object input (never throws)", () => {
    expect(extractEffectiveSystemPrompt(null)).toBeNull();
    expect(extractEffectiveSystemPrompt(undefined)).toBeNull();
    expect(extractEffectiveSystemPrompt(42)).toBeNull();
  });
});

describe("extractModelMeta / extractVoiceMeta", () => {
  it("picks only the present model fields", () => {
    const a = { model: { provider: "openai", model: "gpt-5.2", maxTokens: 150 } };
    expect(extractModelMeta(a)).toEqual({ provider: "openai", model: "gpt-5.2", maxTokens: 150 });
  });
  it("omits absent fields rather than emitting undefined", () => {
    expect(extractModelMeta({ model: { provider: "openai" } })).toEqual({ provider: "openai" });
  });
  it("returns {} when model/voice is missing or not an object", () => {
    expect(extractModelMeta({})).toEqual({});
    expect(extractModelMeta(null)).toEqual({});
    expect(extractVoiceMeta({ voice: "x" })).toEqual({});
  });
  it("picks present voice fields", () => {
    const a = { voice: { provider: "11labs", voiceId: "abc", stability: 0.85 } };
    expect(extractVoiceMeta(a)).toEqual({ provider: "11labs", voiceId: "abc", stability: 0.85 });
  });
});

describe("sha256Hex", () => {
  it("matches the known sha256 vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("is deterministic + 64 lowercase-hex chars for non-ASCII (em-dash) input", () => {
    const s = "[System Instructions — Voizo Platform]\nbig prompt …";
    const h = sha256Hex(s);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(h).toBe(sha256Hex(s));
  });
});
