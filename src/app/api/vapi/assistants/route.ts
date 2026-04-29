/**
 * GET /api/vapi/assistants
 *
 * Returns the list of Vapi assistants on the account so the Campaign V2 create
 * page can offer a dropdown. Now also returns each assistant's current voice
 * and system prompt — the form pre-fills these when the operator selects a base
 * agent, and they can override before saving (clone-per-campaign).
 *
 * Server-side only — the Vapi private key never leaves this handler.
 *
 * Vapi API: GET https://api.vapi.ai/assistant
 * Auth:     Bearer <VAPI_PRIVATE_KEY>
 */

import { NextResponse } from "next/server";

interface VapiAssistantRaw {
  id: string;
  name?: string;
  voice?: {
    voiceId?: string;
    provider?: string;
    model?: string;
    stability?: number;
    similarityBoost?: number;
  };
  model?: {
    messages?: { role: string; content: string }[];
  };
  firstMessage?: string;
}

export async function GET() {
  const key = process.env.VAPI_PRIVATE_KEY;
  if (!key) {
    return NextResponse.json(
      { error: "VAPI_PRIVATE_KEY is not set" },
      { status: 500 },
    );
  }

  try {
    const response = await fetch("https://api.vapi.ai/assistant", {
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${key}`,
      },
      cache: "no-store",
    });

    if (!response.ok) {
      const body = await response.text();
      return NextResponse.json(
        { error: `Vapi ${response.status}: ${body.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const raw = (await response.json()) as VapiAssistantRaw[];
    const assistants = (raw ?? [])
      .map((a) => {
        const sysMsg = a.model?.messages?.find((m) => m.role === "system");
        return {
          id: a.id,
          name: a.name ?? "(unnamed)",
          voiceId: a.voice?.voiceId ?? null,
          voiceProvider: a.voice?.provider ?? null,
          systemPrompt: sysMsg?.content ?? null,
          firstMessage: a.firstMessage ?? null,
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ assistants });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Network error: ${message}` },
      { status: 502 },
    );
  }
}
