/**
 * GET /api/vapi/assistants
 *
 * Returns the list of Vapi assistants on the account so the Campaign V2 create
 * page can offer a dropdown instead of asking operators to paste a UUID.
 *
 * Server-side only — the Vapi private key never leaves this handler. The
 * client receives only { id, name } pairs.
 *
 * Vapi API: GET https://api.vapi.ai/assistant
 * Auth:     Bearer <VAPI_PRIVATE_KEY>
 */

import { NextResponse } from "next/server";

interface VapiAssistant {
  id: string;
  name?: string;
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

    const raw = (await response.json()) as VapiAssistant[];
    const assistants = (raw ?? [])
      .map((a) => ({ id: a.id, name: a.name ?? "(unnamed)" }))
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
