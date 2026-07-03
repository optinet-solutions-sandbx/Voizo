// Shared per-campaign prompt identity resolver (Slice B). Extracted from the analytics route so the
// analytics + records routes resolve + filter prompts IDENTICALLY (single source of truth). Chunks
// the prompt_versions .in() at 150 ids — the repo-wide PostgREST ~16KB URL-header guard (the prior
// inline version was unbounded; identical results for current data, safe at scale).

import { supabaseAdmin } from "@/lib/supabaseServer";
import { promptLabel, type DashCampaignRow } from "@/lib/dashboardAnalytics";
import { sha256Hex } from "@/lib/promptVersionExtract";

export interface PromptIdentity {
  sha: string;
  label: string;
  baseAssistantId: string | null;
}

const IN_CHUNK = 150;

/** Map campaign_id → prompt identity: the latest prompt_versions snapshot if any, else the campaign's
 *  stored system_prompt (hashed the same way so identical text groups under one sha). */
export async function resolvePromptByCampaign(
  live: (DashCampaignRow & { system_prompt?: string | null })[],
): Promise<Map<string, PromptIdentity>> {
  const promptByCampaign = new Map<string, PromptIdentity>();
  const liveIds = live.map((c) => c.id);
  const latestByCampaign = new Map<string, { system_prompt: string; sha: string }>();

  // Each campaign_id lives in exactly one chunk, so "latest per campaign" (order desc + first-wins)
  // stays correct across chunks.
  for (let i = 0; i < liveIds.length; i += IN_CHUNK) {
    const { data: pv } = await supabaseAdmin
      .from("prompt_versions")
      .select("campaign_id, system_prompt, prompt_sha256, created_at")
      .in("campaign_id", liveIds.slice(i, i + IN_CHUNK))
      .order("created_at", { ascending: false });
    for (const v of (pv ?? []) as { campaign_id: string; system_prompt: string; prompt_sha256: string }[]) {
      if (!latestByCampaign.has(v.campaign_id)) {
        latestByCampaign.set(v.campaign_id, { system_prompt: v.system_prompt, sha: v.prompt_sha256 });
      }
    }
  }

  for (const c of live) {
    const baseAssistantId = c.base_assistant_id ?? null;
    const latest = latestByCampaign.get(c.id);
    if (latest) {
      promptByCampaign.set(c.id, { sha: latest.sha, label: promptLabel(latest.system_prompt, latest.sha), baseAssistantId });
    } else if (c.system_prompt) {
      const sha = sha256Hex(c.system_prompt);
      promptByCampaign.set(c.id, { sha, label: promptLabel(c.system_prompt, sha), baseAssistantId });
    }
  }

  return promptByCampaign;
}
