// src/lib/qa/judgeClients.ts
// Provider factory for the QA judge. Returns a JudgeClient (the Anthropic-shaped
// interface scoreCall + its tests use) for either OpenAI or Anthropic, so the rest
// of the judge is provider-blind.
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { ANTHROPIC_API_KEY, OPENAI_API_KEY, QA_JUDGE_PROVIDER } from "./qaConfig";
import type { JudgeClient } from "./scoreCall";

let _client: JudgeClient | null = null;

/**
 * Lazily build the judge client for the active provider; null when its key is absent
 * (flag-OFF safe). Cached after first build (provider is fixed at module load).
 *
 * The OpenAI path is an ADAPTER conforming to the Anthropic-shaped JudgeClient — it
 * reads the system/user text out of the Anthropic-style args, calls chat.completions,
 * and returns the reply wrapped as { content: [{ type: "text", text }] } so scoreCall
 * (and its tests) never change between providers.
 *
 * Param-conservative on the OpenAI side (model + messages + JSON mode only — no
 * temperature / max_completion_tokens) so it works across chat AND reasoning models
 * regardless of which params gpt-5.5 restricts. Tune once the exact model is confirmed.
 */
export function getJudgeClient(): JudgeClient | null {
  if (_client) return _client;

  if (QA_JUDGE_PROVIDER === "anthropic") {
    if (!ANTHROPIC_API_KEY) return null;
    _client = new Anthropic({ apiKey: ANTHROPIC_API_KEY }) as unknown as JudgeClient;
    return _client;
  }

  // default: openai
  if (!OPENAI_API_KEY) return null;
  const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
  _client = {
    messages: {
      async create(args: unknown) {
        const a = args as {
          model: string;
          system?: Array<{ text?: string }>;
          messages?: Array<{ role: string; content: string }>;
        };
        const systemText = (a.system ?? []).map((s) => s.text ?? "").join("\n");
        const userText = (a.messages ?? []).map((m) => m.content).join("\n");
        const resp = await openai.chat.completions.create({
          model: a.model,
          messages: [
            { role: "system", content: systemText },
            { role: "user", content: userText },
          ],
          response_format: { type: "json_object" },
        });
        const text = resp.choices?.[0]?.message?.content ?? "";
        return { content: [{ type: "text", text }] };
      },
    },
  };
  return _client;
}
