/**
 * GET /api/vapi/knowledge-bases
 *
 * Returns the list of knowledge bases on the Vapi account so the
 * Campaign V2 form can offer an optional dropdown.
 *
 * Server-side only — VAPI_PRIVATE_KEY never leaves this handler.
 */

import { NextResponse } from "next/server";

interface VapiKnowledgeBase {
  id: string;
  name?: string;
  description?: string;
  createdAt?: string;
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
    const response = await fetch("https://api.vapi.ai/knowledge-base", {
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

    const raw = (await response.json()) as VapiKnowledgeBase[];
    const knowledgeBases = (raw ?? [])
      .map((kb) => ({
        id: kb.id,
        name: kb.name ?? "(unnamed)",
        description: kb.description ?? null,
        createdAt: kb.createdAt ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({ knowledgeBases });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Network error: ${message}` },
      { status: 502 },
    );
  }
}
