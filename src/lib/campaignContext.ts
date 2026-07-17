// Pure normalizer for the call-detail modal's campaign context (2026-07-17).
// The route embeds campaigns_v2 via the campaign_numbers_v2 FK; Supabase FK
// embeds arrive as an OBJECT or an ARRAY depending on relationship inference
// (same edge labelData's campaignBrief handles). No deps — unit-testable with
// relative imports, importable by the route (route files can't export helpers).

export interface CampaignContext {
  name: string;
  agentName: string | null;
  /** campaigns_v2.agent_mode: "assistant" (legacy prompt path) | "script" */
  mode: string;
  scriptName: string | null;
  voiceName: string | null;
  /** campaigns_v2.system_prompt — the full prompt in agent mode; in script mode
   *  the wizard persists the PERSONA here (wizardState.ts buildCreateInput). */
  prompt: string | null;
  /** campaigns_v2.base_assistant_id — the Vapi id of the BASE agent the campaign
   *  clone was made from (e.g. Val/Ernie). The route resolves it to the base's
   *  human name; null on campaigns predating the column (fallback = clone name). */
  baseAssistantId: string | null;
}

export function campaignContextFrom(embed: unknown): CampaignContext | null {
  const row = Array.isArray(embed) ? embed[0] : embed;
  if (!row || typeof row !== "object") return null;
  const r = row as Record<string, unknown>;
  if (typeof r.name !== "string" || typeof r.agent_mode !== "string") return null;
  const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
  return {
    name: r.name,
    agentName: str(r.vapi_assistant_name),
    mode: r.agent_mode,
    scriptName: str(r.script_name),
    voiceName: str(r.voice_name),
    prompt: str(r.system_prompt),
    baseAssistantId: str(r.base_assistant_id),
  };
}
