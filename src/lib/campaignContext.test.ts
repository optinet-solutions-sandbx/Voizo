import { describe, it, expect } from "vitest";
import { campaignContextFrom } from "./campaignContext";

// Raw campaigns_v2 embed as the call-detail route selects it. Supabase FK embeds
// arrive as an OBJECT or an ARRAY depending on relationship inference — same edge
// labelData's campaignBrief handles.
const ROW = {
  name: "L7_AU_STEVIC_PROMPT_RND_20NDFS_300%DEPMATCH_13/07/2026",
  vapi_assistant_name: "L7_AU_STEVIC_PROMPT_RND",
  agent_mode: "assistant",
  script_name: null,
  system_prompt: "You are Tom from Lucky Seven Casino...",
  voice_name: "Val",
  base_assistant_id: "3b0c2ad0-db3c-4e80-ac99-57fa66f1bf78",
};

describe("campaignContextFrom", () => {
  it("maps an object-form embed to the context shape (incl. base assistant id)", () => {
    expect(campaignContextFrom(ROW)).toEqual({
      name: "L7_AU_STEVIC_PROMPT_RND_20NDFS_300%DEPMATCH_13/07/2026",
      agentName: "L7_AU_STEVIC_PROMPT_RND",
      mode: "assistant",
      scriptName: null,
      voiceName: "Val",
      prompt: "You are Tom from Lucky Seven Casino...",
      baseAssistantId: "3b0c2ad0-db3c-4e80-ac99-57fa66f1bf78",
    });
  });

  it("unwraps an array-form embed (first row)", () => {
    expect(campaignContextFrom([ROW])?.name).toBe(ROW.name);
  });

  it("passes script-mode fields through (script campaigns persist the persona to system_prompt)", () => {
    const script = { ...ROW, agent_mode: "script", script_name: "Val - 20FS + 300% DB", system_prompt: "You are Victor..." };
    expect(campaignContextFrom(script)).toMatchObject({
      mode: "script",
      scriptName: "Val - 20FS + 300% DB",
      prompt: "You are Victor...",
    });
  });

  it("returns null for null, undefined, empty array and malformed embeds", () => {
    expect(campaignContextFrom(null)).toBeNull();
    expect(campaignContextFrom(undefined)).toBeNull();
    expect(campaignContextFrom([])).toBeNull();
    expect(campaignContextFrom("garbage")).toBeNull();
  });

  it("null-safes missing optional fields (incl. campaigns predating base_assistant_id)", () => {
    expect(campaignContextFrom({ name: "X", agent_mode: "assistant" })).toEqual({
      name: "X",
      agentName: null,
      mode: "assistant",
      scriptName: null,
      voiceName: null,
      prompt: null,
      baseAssistantId: null,
    });
  });
});
